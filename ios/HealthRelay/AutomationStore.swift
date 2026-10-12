import Foundation
import Observation
import Security
import HealthRelayCore
import HealthKit
import BackgroundTasks
import UserNotifications

@MainActor @Observable
final class AutomationStore {
    static let shared = AutomationStore()
    private(set) var tasks: [AutomationConfig] = []
    private(set) var loadError: String?
    private let repository: ConfigurationRepository
    let credentials = CredentialStore()
    let health = HealthKitReader()
    let journal: SyncJournal
    private(set) var outcomes: [UUID: RunLog] = [:]
    private(set) var active: Set<UUID> = []
    private var observers: [HKObserverQuery] = []
    @ObservationIgnored lazy var engine = SyncEngine(reader: reader, sender: HTTPUploader(credential: { [credentials] in try credentials.read($0) }), journal: journal)
    private var reader: any HealthDataReader {
        #if DEBUG && targetEnvironment(simulator)
        if ProcessInfo.processInfo.arguments.contains("--synthetic-health") { return SyntheticHealthReader() }
        #endif
        return health
    }
    static let refreshIdentifier = "org.healthrelay.app.refresh"
    private let dirtyKey = "HealthRelay.dirtyTasks"


    init() {
        let testing = ProcessInfo.processInfo.arguments.contains("--ui-testing")
        let directory = URL.applicationSupportDirectory.appendingPathComponent(testing ? "HealthRelay-UITests" : "HealthRelay", isDirectory: true)
        let file = directory.appendingPathComponent("tasks.json")
        if testing && ProcessInfo.processInfo.arguments.contains("--reset-configurations") {
            try? FileManager.default.removeItem(at: directory)
        }
        repository = ConfigurationRepository(fileURL: file)
        journal = SyncJournal(directory: directory.appendingPathComponent("sync", isDirectory: true))
        do { tasks = try repository.load() }
        catch { loadError = error.localizedDescription }
        #if DEBUG
        if tasks.isEmpty {
            do { if let fixture = try DebugFixture.install(repository: repository, credentials: credentials) { tasks = [fixture] } }
            catch { loadError = "真机验收配置创建失败：" + error.localizedDescription }
        }
        #endif
        #if DEBUG && targetEnvironment(simulator)
        if ProcessInfo.processInfo.arguments.contains("--synthetic-health"), tasks.isEmpty,
           let endpoint = ProcessInfo.processInfo.environment["HEALTHRELAY_ACCEPTANCE_ENDPOINT"],
           let key = ProcessInfo.processInfo.environment["HEALTHRELAY_ACCEPTANCE_KEY"] {
            var fixture = AutomationConfig.newTask()
            fixture.name = "合成数据链路验收"
            fixture.data.selections = [MetricSelection(typeIdentifier: "HKQuantityTypeIdentifierBodyMass", unit: "kg")]
            fixture.destination.url = endpoint; fixture.destination.acknowledgement = .receipt
            do {
                fixture.destination.headers = ["X-Acceptance-Key": key]
                try repository.save([fixture]); tasks = [fixture]
            } catch { loadError = "验收配置创建失败" }
        }
        #endif
        for task in tasks { outcomes[task.id] = try? journal.load(task.id).logs.first }
        BGTaskScheduler.shared.register(forTaskWithIdentifier: Self.refreshIdentifier, using: nil) { [weak self] task in
            Task { @MainActor in
                guard let self else { task.setTaskCompleted(success: false); return }
                let work = Task { await self.runDue(dataChangeOnly: false) }
                task.expirationHandler = { work.cancel() }
                await work.value
                task.setTaskCompleted(success: !work.isCancelled)
            }
        }
    }

    func save(_ task: AutomationConfig) throws {
        guard loadError == nil else { throw ConfigurationError("本地配置未能读取，保存已停止以保护原文件") }
        guard !active.contains(task.id) else { throw ConfigurationError("任务正在运行，请完成后再修改配置") }
        guard try journal.load(task.id).pending == nil else { throw ConfigurationError("有待上传批次，请先重试完成后再修改配置") }
        var updated = tasks
        var candidate = task
        if let index = updated.firstIndex(where: { $0.id == task.id }) {
            candidate.revision = updated[index].revision + 1
            updated[index] = candidate
        } else { updated.append(candidate) }
        try repository.save(updated)
        tasks = updated
        Task { await configureObservers() }
    }

    func delete(_ task: AutomationConfig) throws {
        guard loadError == nil else { throw ConfigurationError("本地配置未能读取") }
        guard !active.contains(task.id) else { throw ConfigurationError("任务正在运行，请完成后再删除") }
        let updated = tasks.filter { $0.id != task.id }
        try repository.save(updated)
        tasks = updated
        try journal.remove(task.id)
        removeCredentials(task)
        Task { await configureObservers() }
    }

    func checkRead(_ task: AutomationConfig) async throws -> String {
        guard active.insert(task.id).inserted else { throw ConfigurationError("任务正在运行") }
        defer { active.remove(task.id) }
        try await health.authorize(task)
        var summaries: [String] = []
        for selection in task.data.selections {
            let (_, initial) = try SyncIdentity.key(task, selection: selection, now: Date())
            let page = try await health.read(task: task, selection: selection, checkpoint: initial, limit: 20)
            let times = page.records.compactMap(\.start).sorted()
            let name = MetricCatalog.bundled.metric(selection.id)?.title ?? selection.id
            summaries.append("\(name)：读到 \(page.records.count) 条\(page.hasMore ? "（还有更多）" : "")\(times.last.map { "，最新 " + $0 } ?? "")")
        }
        return summaries.joined(separator: "\n") + "\n本次仅检查读取，未上传，也不推进同步位置。"
    }

    func setEnabled(_ task: AutomationConfig, enabled: Bool) async throws {
        guard !active.contains(task.id) else { throw ConfigurationError("任务正在运行") }
        var updated = tasks
        guard let index = updated.firstIndex(where: { $0.id == task.id }) else { return }
        if enabled {
            let issues = task.validationIssues(systemMajorVersion: ProcessInfo.processInfo.operatingSystemVersion.majorVersion) + task.executionIssues
            guard issues.isEmpty else { throw ConfigurationError(issues.joined(separator: "；")) }
            try await health.authorize(task)
            if (task.execution.notifyOnFailure ?? true) || task.execution.notifyOnSuccess == true {
                _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
            }
        }
        updated[index].enabled = enabled
        try repository.save(updated); tasks = updated
        await configureObservers()
    }

    func run(_ task: AutomationConfig, automatic: Bool = false) async {
        guard active.insert(task.id).inserted else { return }
        defer { active.remove(task.id); scheduleRefresh() }
        var dirtyAtStart = Set(UserDefaults.standard.stringArray(forKey: dirtyKey) ?? [])
        dirtyAtStart.remove(task.id.uuidString)
        UserDefaults.standard.set(Array(dirtyAtStart), forKey: dirtyKey)
        outcomes[task.id] = RunLog(state: .running, message: "正在读取并上传")
        do {
            if !automatic {
                #if DEBUG && targetEnvironment(simulator)
                if !ProcessInfo.processInfo.arguments.contains("--synthetic-health") { try await health.authorize(task) }
                #else
                try await health.authorize(task)
                #endif
            }
            let outcome = await engine.run(task, automatic: automatic)
            outcomes[task.id] = outcome
            if outcome.state == .failed || outcome.state == .queued { markDirty(task.id) }
            if automatic && ((outcome.state == .failed && (task.execution.notifyOnFailure ?? true)) || (outcome.state == .succeeded && task.execution.notifyOnSuccess == true)) {
                let content = UNMutableNotificationContent(); content.title = "HealthRelay · \(task.name)"; content.body = outcome.message
                try? await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: task.id.uuidString, content: content, trigger: nil))
            }
        } catch {
            outcomes[task.id] = RunLog(state: .failed, message: "健康数据暂不可读，请解锁并检查健康读取权限")
            markDirty(task.id)
        }
    }

    private func markDirty(_ id: UUID) {
        var dirty = Set(UserDefaults.standard.stringArray(forKey: dirtyKey) ?? [])
        dirty.insert(id.uuidString); UserDefaults.standard.set(Array(dirty), forKey: dirtyKey)
    }

    func cancelPending(_ task: AutomationConfig) throws {
        guard !active.contains(task.id) else { throw ConfigurationError("任务正在运行") }
        var state = try journal.load(task.id)
        guard state.pending != nil else { return }
        state.pending = nil
        let log = RunLog(state: .queued, message: "已取消待上传批次，未推进游标；下次从上次确认的位置重新读取")
        state.logs.insert(log, at: 0); state.logs = Array(state.logs.prefix(30))
        try journal.save(state, for: task.id)
        outcomes[task.id] = log; markDirty(task.id)
    }

    func runDue(dataChangeOnly: Bool = false) async {
        guard loadError == nil else { return }
        for task in tasks where task.enabled {
            if Task.isCancelled { break }
            guard let state = try? journal.load(task.id) else { continue }
            let dirty = Set(UserDefaults.standard.stringArray(forKey: dirtyKey) ?? [])
            guard state.pending != nil || (!dataChangeOnly && task.execution.onForeground) || dirty.contains(task.id.uuidString) else { continue }
            guard state.pending != nil || Date().timeIntervalSince(state.lastAttempt ?? .distantPast) >= Double(task.execution.minimumIntervalSeconds) else { continue }
            await run(task, automatic: true)
        }
        scheduleRefresh()
    }

    func configureObservers() async {
        for query in observers { health.health.stop(query) }; observers = []
        await withCheckedContinuation { continuation in
            health.health.disableAllBackgroundDelivery { _, _ in continuation.resume() }
        }
        let identifiers = Set(tasks.filter { $0.enabled && $0.execution.onDataChange }.flatMap { $0.data.selections.map(\.id) })
        for id in identifiers {
            guard let type = try? health.sampleType(id) else { continue }
            let query = HKObserverQuery(sampleType: type, predicate: nil) { [weak self] _, complete, error in
                let completion = ObserverCompletion(complete)
                Task { @MainActor in
                    defer { completion.call() }
                    guard let self, error == nil else { return }
                    var dirty = Set(UserDefaults.standard.stringArray(forKey: self.dirtyKey) ?? [])
                    for task in self.tasks where task.enabled && task.execution.onDataChange && task.data.selections.contains(where: { $0.id == id }) { dirty.insert(task.id.uuidString) }
                    UserDefaults.standard.set(Array(dirty), forKey: self.dirtyKey)
                    self.scheduleRefresh()
                    Task { await self.runDue(dataChangeOnly: true) }
                }
            }
            observers.append(query); health.health.execute(query)
            do { try await health.health.enableBackgroundDelivery(for: type, frequency: .immediate) }
            catch {
                for task in tasks where task.data.selections.contains(where: { $0.id == id }) && task.enabled {
                    outcomes[task.id] = RunLog(state: .failed, message: "此类型的后台通知未能启用，仍可手动运行；请检查签名能力")
                }
            }
        }
        scheduleRefresh()
    }

    private func scheduleRefresh() {
        let enabled = tasks.filter(\.enabled)
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: Self.refreshIdentifier)
        guard !enabled.isEmpty else { return }
        let dates = enabled.compactMap { task -> Date? in
            guard let state = try? journal.load(task.id) else { return nil }
            if let pending = state.pending { return pending.automaticRetry ? pending.nextAttempt ?? Date() : nil }
            let dirty = UserDefaults.standard.stringArray(forKey: dirtyKey) ?? []
            guard task.execution.onForeground || dirty.contains(task.id.uuidString) else { return nil }
            return (state.lastAttempt ?? Date()).addingTimeInterval(Double(task.execution.minimumIntervalSeconds))
        }
        guard let earliest = dates.min() else { return }
        let request = BGAppRefreshTaskRequest(identifier: Self.refreshIdentifier)
        request.earliestBeginDate = max(Date().addingTimeInterval(60), earliest)
        try? BGTaskScheduler.shared.submit(request)
    }

    func removeCredentials(_ task: AutomationConfig) {
        if let ref = task.destination.credentialRef { credentials.delete(ref) }
        for ref in task.destination.secretHeaders?.values ?? Dictionary<String, String>().values { credentials.delete(ref) }
    }
}

struct CredentialStore {
    private let service = "org.healthrelay.automation-credentials"
    func save(_ value: String) throws -> String {
        let reference = UUID().uuidString
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: reference,
            kSecValueData as String: Data(value.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        ]
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw ConfigurationError("认证信息保存失败（\(status)）") }
        return reference
    }
    func read(_ reference: String) throws -> String {
        var result: CFTypeRef?
        let status = SecItemCopyMatching([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: reference,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ] as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data, let value = String(data: data, encoding: .utf8) else {
            throw UploadFailure(status == errSecInteractionNotAllowed ? "设备锁定，认证值暂不可读" : "认证值无法读取，请重新填写", retryable: status == errSecInteractionNotAllowed)
        }
        return value
    }
    func delete(_ reference: String) {
        SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: reference
        ] as CFDictionary)
    }
}

/// Apple's completion callback is not annotated Sendable; invoke it exactly once
/// after recording the change, independent of network work.
private final class ObserverCompletion: @unchecked Sendable {
    private let lock = NSLock()
    private var callback: (() -> Void)?
    init(_ callback: @escaping () -> Void) { self.callback = callback }
    func call() {
        lock.lock(); let value = callback; callback = nil; lock.unlock()
        value?()
    }
}
