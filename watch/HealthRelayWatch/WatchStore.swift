import Foundation
import Observation
import HealthKit
import WatchKit
import WatchConnectivity
import HealthRelayCore

@MainActor @Observable final class WatchStore: NSObject, WCSessionDelegate {
    static let shared = WatchStore()
    private(set) var tasks: [AutomationConfig] = []
    private(set) var outcomes: [UUID: RunLog] = [:]
    private(set) var active: Set<UUID> = []
    private(set) var status = "请在 iPhone 同步 Watch 配置"
    private(set) var loadError: String?
    let journal: SyncJournal
    let uploader: BackgroundUploader
    private var snapshotReceipt: WatchSnapshotReceipt?
    private let repository: ConfigurationRepository
    private let credentials = CredentialStore()
    private let health = HealthKitReader()
    private let coordinator = RunCoordinator()
    private let observerCoordinator = RunCoordinator()
    private var observers: [HKObserverQuery] = []
    private var connectivityTasks: [() -> Void] = []
    private var connectivityObservation: NSKeyValueObservation?
    @ObservationIgnored nonisolated private let pendingImports = PendingImportCounter()
    private var runningDue = false
    private let dirtyKey = "Watch.dirtyTasks"
    @ObservationIgnored private lazy var engine = SyncEngine(reader: reader, sender: DeferredOnlySender(), journal: journal)

    private var reader: any HealthDataReader {
        #if DEBUG && targetEnvironment(simulator)
        if WatchAcceptanceFixture.active { return SyntheticHealthReader() }
        #endif
        return health
    }
    override init() {
        let directory = URL.applicationSupportDirectory.appendingPathComponent("HealthRelayWatch", isDirectory: true)
        repository = ConfigurationRepository(fileURL: directory.appendingPathComponent("tasks.json"))
        journal = SyncJournal(directory: directory.appendingPathComponent("sync", isDirectory: true))
        uploader = BackgroundUploader(directory: directory.appendingPathComponent("uploads", isDirectory: true), credentials: CredentialStore())
        super.init()
        do { tasks = try repository.load(); snapshotReceipt = try repository.loadWatchReceipt(); for task in tasks { outcomes[task.id] = try journal.load(task.id).logs.first } }
        catch { loadError = "本地任务或同步状态无法读取，执行已停止以保护原文件" }
        #if DEBUG && targetEnvironment(simulator)
        if tasks.isEmpty, WatchAcceptanceFixture.active {
            do {
                if let fixture = try WatchAcceptanceFixture.install(repository: repository, credentials: credentials) { tasks = [fixture] }
            } catch { loadError = "合成验收配置无效：" + error.localizedDescription }
        }
        if WatchAcceptanceFixture.active {
            do { for task in tasks { try WatchAcceptanceFixture.validate(task) } }
            catch { loadError = error.localizedDescription }
        }
        #endif
        status = UserDefaults.standard.string(forKey: "Watch.snapshotStatus") ?? status
        uploader.onCompletion = { [weak self] in Task { await self?.applyCompletions() } }
        uploader.connect()
        if WCSession.isSupported() {
            let session = WCSession.default
            session.delegate = self
            connectivityObservation = session.observe(\.hasContentPending, options: [.new]) { [weak self] _, _ in
                Task { @MainActor in self?.finishConnectivityTasks() }
            }
            session.activate()
        }
    }
    func start() async { await applyCompletions(); await configureObservers(); await runDue(trigger: "foreground") }

    private func drainCompletions() throws {
        for (file, result) in try uploader.storedCompletions() {
            if let task = tasks.first(where: { $0.id == result.identity.taskID }) {
                do {
                    if let failure = result.failure { throw UploadFailure(failure, retryable: result.retryable, status: result.status) }
                    guard let status = result.status else { throw UploadFailure("接口响应无效", retryable: true) }
                    _ = try journal.confirm(result.identity, task: task, status: status, data: result.body)
                } catch let failure as UploadFailure {
                    var failure = failure
                    failure.retryAfter = HTTPAcknowledgement.retryDelay(result.retryAfter)
                    _ = try journal.recordFailure(result.identity, failure: failure)
                }
                outcomes[task.id] = try journal.load(task.id).logs.first
            }
            try uploader.consumed(file, identity: result.identity)
        }
        if let error = uploader.storageError { throw ConfigurationError(error) }
    }
    func applyCompletions() async {
        await coordinator.acquire(); defer { coordinator.release(); scheduleRefresh() }
        do { try drainCompletions() } catch { status = error.localizedDescription }
    }
    func run(_ id: UUID, automatic: Bool = false, trigger: String = "manual") async {
        guard loadError == nil, active.insert(id).inserted else { return }
        defer { active.remove(id); scheduleRefresh() }
        await coordinator.acquire(); defer { coordinator.release() }
        do {
            try Task.checkCancellation()
            try drainCompletions()
            guard let task = tasks.first(where: { $0.id == id }), task.device == .watch, task.enabled else { return }
            #if DEBUG && targetEnvironment(simulator)
            if WatchAcceptanceFixture.active { try WatchAcceptanceFixture.validate(task) }
            #endif
            let previous = try journal.load(id)
            if automatic, let pending = previous.pending,
               !pending.automaticRetry || (pending.nextAttempt ?? .distantPast) > Date() { return }
            var dirtyAtStart = Set(UserDefaults.standard.stringArray(forKey: dirtyKey) ?? [])
            dirtyAtStart.remove(id.uuidString)
            UserDefaults.standard.set(Array(dirtyAtStart), forKey: dirtyKey)
            let log = await engine.run(task, automatic: automatic, timeBudget: 12, trigger: trigger, prepareOnly: true)
            outcomes[id] = log
            if let pending = try journal.load(id).pending {
                let identity = BatchIdentity(taskID: id, batchID: pending.batchID, fingerprint: pending.configurationFingerprint)
                do {
                    try await uploader.enqueue(task: task, pending: pending)
                    outcomes[id] = RunLog(state: .queued, message: "批次已持久化并交给系统传输，等待接口确认")
                } catch {
                    _ = try journal.recordFailure(identity, failure: (error as? UploadFailure) ?? UploadFailure("后台传输未能排队，批次保留", retryable: true))
                    outcomes[id] = try journal.load(id).logs.first
                }
            }
            if log.state == .failed {
                var dirty = Set(UserDefaults.standard.stringArray(forKey: dirtyKey) ?? [])
                dirty.insert(id.uuidString)
                UserDefaults.standard.set(Array(dirty), forKey: dirtyKey)
            }
        } catch { outcomes[id] = RunLog(state: .failed, message: error is CancellationError ? "系统执行时间结束，未确认批次保留" : error.localizedDescription) }
    }
    func runDue(trigger: String) async {
        guard loadError == nil, !runningDue else { return }
        runningDue = true; defer { runningDue = false; scheduleRefresh() }
        await applyCompletions()
        let deadline = Date().addingTimeInterval(15)
        let dirty = Set(UserDefaults.standard.stringArray(forKey: dirtyKey) ?? [])
        let candidates = tasks.filter { $0.device == .watch && $0.enabled }.sorted {
            ((try? journal.load($0.id).lastAttempt) ?? .distantPast) < ((try? journal.load($1.id).lastAttempt) ?? .distantPast)
        }
        for task in candidates {
            guard !Task.isCancelled, Date() < deadline else { break }
            guard let state = try? journal.load(task.id) else { continue }
            if let pending = state.pending {
                guard pending.automaticRetry, (pending.nextAttempt ?? .distantPast) <= Date() else { continue }
            } else if state.nextSelectionID == nil {
                let foreground = trigger == "foreground" && task.execution.onForeground
                let periodic = trigger == "background" && task.execution.periodicPolling == true
                guard foreground || periodic || (task.execution.onDataChange && dirty.contains(task.id.uuidString)) else { continue }
                guard Date().timeIntervalSince(state.lastAttempt ?? .distantPast) >= Double(task.execution.minimumIntervalSeconds) else { continue }
            }
            await run(task.id, automatic: true, trigger: trigger)
        }
    }
    func setEnabled(_ id: UUID, enabled: Bool) async throws {
        await coordinator.acquire(); defer { coordinator.release() }
        guard loadError == nil, let index = tasks.firstIndex(where: { $0.id == id }) else { throw ConfigurationError("任务不可用") }
        if enabled {
            let task = tasks[index]
            let issues = task.validationIssues(systemMajorVersion: ProcessInfo.processInfo.operatingSystemVersion.majorVersion, device: .watch) + task.executionIssues
            guard issues.isEmpty else { throw ConfigurationError(issues.joined(separator: "；")) }
            for reference in WatchConfigurationSnapshot.references(task) { _ = try credentials.read(reference) }
            try await health.authorize(task)
        }
        var updated = tasks; updated[index].enabled = enabled
        try repository.save(updated, watchReceipt: snapshotReceipt); tasks = updated
        Task { await configureObservers() }
    }
    func cancelPending(_ id: UUID) async throws {
        guard active.insert(id).inserted else { throw ConfigurationError("任务正在运行") }
        defer { active.remove(id); scheduleRefresh() }
        await coordinator.acquire(); defer { coordinator.release() }
        try drainCompletions()
        guard let pending = try journal.load(id).pending else { return }
        let identity = BatchIdentity(taskID: id, batchID: pending.batchID, fingerprint: pending.configurationFingerprint)
        await uploader.cancel(identity)
        try drainCompletions()
        _ = try journal.discard(identity)
        try uploader.removeBody(identity)
        outcomes[id] = try journal.load(id).logs.first
    }
    func requiredHeaders(_ task: AutomationConfig) -> [String] {
        Set((task.destination.requiredSecretHeaders ?? []) + Array((task.destination.secretHeaders ?? [:]).keys) + [task.destination.credentialHeader].compactMap { $0 }).sorted()
    }
    func saveCredentials(_ id: UUID, values: [String: String]) async throws {
        await coordinator.acquire(); defer { coordinator.release() }
        guard loadError == nil, let index = tasks.firstIndex(where: { $0.id == id }) else { throw ConfigurationError("任务不可用") }
        guard try journal.load(id).pending == nil else { throw ConfigurationError("有未确认批次，请先完成后再修改认证") }
        let old = tasks[index]; var updated = old; var created: [String] = []
        do {
            for name in requiredHeaders(old) {
                let existing = name == old.destination.credentialHeader ? old.destination.credentialRef : old.destination.secretHeaders?[name]
                let value = values[name] ?? ""
                guard !AutomationConfig.containsHeaderLineBreak(value), value.utf8.count <= 16_384 else { throw ConfigurationError("认证值格式无效") }
                if value.isEmpty {
                    guard existing != nil else { throw ConfigurationError("请填写 \(name)") }
                    continue
                }
                let reference = try credentials.save(value); created.append(reference)
                if name == old.destination.credentialHeader { updated.destination.credentialRef = reference }
                else {
                    if updated.destination.secretHeaders == nil { updated.destination.secretHeaders = [:] }
                    updated.destination.secretHeaders?[name] = reference
                }
            }
            updated.destination.requiredSecretHeaders = nil
            var all = tasks; all[index] = updated
            try repository.save(all, watchReceipt: snapshotReceipt); tasks = all
            for reference in WatchConfigurationSnapshot.references(old).subtracting(WatchConfigurationSnapshot.references(updated)) { credentials.delete(reference) }
        } catch { for reference in created { credentials.delete(reference) }; throw error }
    }
    func configureObservers() async {
        #if DEBUG && targetEnvironment(simulator)
        if WatchAcceptanceFixture.active { return }
        #endif
        await observerCoordinator.acquire(); defer { observerCoordinator.release(); scheduleRefresh() }
        for query in observers { health.health.stop(query) }; observers.removeAll()
        await withCheckedContinuation { continuation in health.health.disableAllBackgroundDelivery { _, _ in continuation.resume() } }
        let ids = Set(tasks.filter { $0.enabled && $0.execution.onDataChange }.flatMap { $0.data.selections.map(\.id) })
        for id in ids {
            do {
                let type = try health.sampleType(id)
                let query = HKObserverQuery(sampleType: type, predicate: nil) { [weak self] _, completion, error in
                    let callback = HealthObserverCompletion(completion)
                    Task { @MainActor in
                        defer { callback.call() }
                        guard let self, error == nil else { return }
                        var dirty = Set(UserDefaults.standard.stringArray(forKey: self.dirtyKey) ?? [])
                        for task in self.tasks where task.enabled && task.execution.onDataChange && task.data.selections.contains(where: { $0.id == id }) { dirty.insert(task.id.uuidString) }
                        UserDefaults.standard.set(Array(dirty), forKey: self.dirtyKey)
                        self.scheduleRefresh()
                        Task { await self.runDue(trigger: "healthChange") }
                    }
                }
                observers.append(query); health.health.execute(query)
                try await health.health.enableBackgroundDelivery(for: type, frequency: .immediate)
            } catch { status = "部分后台健康通知不可用：" + error.localizedDescription }
        }
    }
    private func scheduleRefresh() {
        let dirty = Set(UserDefaults.standard.stringArray(forKey: dirtyKey) ?? [])
        let dates = tasks.filter(\.enabled).compactMap { task -> Date? in
            guard let state = try? journal.load(task.id) else { return nil }
            if let pending = state.pending { return pending.automaticRetry ? pending.nextAttempt ?? Date().addingTimeInterval(300) : nil }
            if state.nextSelectionID != nil { return Date().addingTimeInterval(60) }
            guard task.execution.periodicPolling == true || (task.execution.onDataChange && dirty.contains(task.id.uuidString)) else { return nil }
            return (state.lastAttempt ?? Date()).addingTimeInterval(Double(task.execution.minimumIntervalSeconds))
        }
        guard let date = dates.min() else { return }
        WKApplication.shared().scheduleBackgroundRefresh(withPreferredDate: max(Date().addingTimeInterval(60), date), userInfo: nil) { [weak self] error in
            if error != nil { Task { @MainActor in self?.status = "系统暂未接受后台刷新，仍可手动运行" } }
        }
    }
    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: (any Error)?) {
        Task { @MainActor in self.finishConnectivityTasks() }
    }
    nonisolated func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any]) {
        guard let data = userInfo["snapshot"] as? Data, let id = userInfo["snapshotID"] as? String else { return }
        pendingImports.begin()
        Task { @MainActor in
            defer { self.pendingImports.end(); self.finishConnectivityTasks() }
            await self.receive(data, id: id)
        }
    }
    private func receive(_ data: Data, id: String) async {
        await coordinator.acquire(); defer { coordinator.release() }
        var accepted = false, reason: String?
        var generation: Int64?
        do {
            guard loadError == nil, data.count <= 61_440 else { throw ConfigurationError("Watch 无法读取本地配置或快照过大") }
            let snapshot = try JSONDecoder().decode(WatchConfigurationSnapshot.self, from: data)
            guard snapshot.id.uuidString == id else { throw ConfigurationError("快照标识不一致") }
            if let receipt = snapshotReceipt, snapshot.id == receipt.id {
                var reply: [String: Any] = ["snapshotID": id, "accepted": receipt.accepted]
                reply["reason"] = receipt.reason
                WCSession.default.transferUserInfo(reply)
                return
            }
            guard snapshot.generation > (snapshotReceipt?.generation ?? 0) else { throw ConfigurationError("过期的 Watch 配置快照已忽略，请重新同步") }
            generation = snapshot.generation
            try snapshot.validate(systemMajorVersion: ProcessInfo.processInfo.operatingSystemVersion.majorVersion)
            try drainCompletions()
            let incoming = snapshot.localTasks(current: tasks)
            try WatchConfigurationSnapshot.validateReplacement(current: tasks, incoming: incoming, journal: journal)
            let old = tasks
            let receipt = WatchSnapshotReceipt(id: snapshot.id, generation: snapshot.generation, accepted: true)
            try repository.save(incoming, watchReceipt: receipt); tasks = incoming; snapshotReceipt = receipt
            let retained = incoming.reduce(into: Set<String>()) { $0.formUnion(WatchConfigurationSnapshot.references($1)) }
            for task in old {
                for reference in WatchConfigurationSnapshot.references(task).subtracting(retained) { credentials.delete(reference) }
                if !incoming.contains(where: { $0.id == task.id }) { try? journal.remove(task.id); outcomes[task.id] = nil }
            }
            status = "已收到 \(incoming.count) 个任务；填写认证、授权并启用后执行"
            accepted = true
            Task { await configureObservers() }
        } catch { reason = error.localizedDescription; status = "配置未更新：" + error.localizedDescription }
        if !accepted, let generation, let identifier = UUID(uuidString: id), loadError == nil {
            let receipt = WatchSnapshotReceipt(id: identifier, generation: generation, accepted: false, reason: reason)
            do { try repository.save(tasks, watchReceipt: receipt); snapshotReceipt = receipt }
            catch { reason = "Watch 配置回执保存失败，请稍后重新同步" }
        }
        UserDefaults.standard.set(status, forKey: "Watch.snapshotStatus")
        var reply: [String: Any] = ["snapshotID": id, "accepted": accepted]
        if let reason { reply["reason"] = reason }
        WCSession.default.transferUserInfo(reply)
    }
    func handleConnectivity(completion: @escaping () -> Void) {
        connectivityTasks.append(completion)
        finishConnectivityTasks()
    }
    private func finishConnectivityTasks() {
        guard pendingImports.isEmpty, WCSession.default.activationState == .activated, !WCSession.default.hasContentPending else { return }
        let tasks = connectivityTasks; connectivityTasks.removeAll()
        for completion in tasks { completion() }
    }
}

private final class HealthObserverCompletion: @unchecked Sendable {
    private let callback: () -> Void
    init(_ callback: @escaping () -> Void) { self.callback = callback }
    func call() { callback() }
}

/// WC invokes its delegate off the main actor. Count the delivery before returning
/// so a background completion cannot race the queued main-actor import.
private final class PendingImportCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    func begin() { lock.lock(); count += 1; lock.unlock() }
    func end() { lock.lock(); count -= 1; lock.unlock() }
    var isEmpty: Bool { lock.lock(); defer { lock.unlock() }; return count == 0 }
}
