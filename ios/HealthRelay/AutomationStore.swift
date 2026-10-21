import Foundation
import Observation
import HealthRelayCore
import HealthKit
import BackgroundTasks
import UserNotifications
import UIKit

@MainActor @Observable
final class AutomationStore {
    static let shared = AutomationStore()
    private(set) var tasks: [AutomationConfig] = []
    private(set) var loadError: String?
    private(set) var waitingForProtectedData = false
    var configurationReady: Bool { loadError == nil && !waitingForProtectedData }
    private let repository: ConfigurationRepository
    let credentials = CredentialStore()
    let watchSync = PhoneWatchSync()
    let health = HealthKitReader()
    private let backfillRepository: BackfillRepository
    private let coordinator = RunCoordinator()
    private let observerCoordinator = RunCoordinator()
    private let reminderCoordinator = RunCoordinator()
    @ObservationIgnored private let reminders = AutomationReminders()
    private(set) var reminderError: String?
    struct ReminderRoute: Identifiable { let id = UUID(); let taskID: UUID? }
    var reminderRoute: ReminderRoute?
    private var checkingDue = false
    @ObservationIgnored private var foregroundActive = false
    @ObservationIgnored private var foregroundWake: Task<Void, Never>?

    private(set) var backfills: [BackfillJob] = []
    let journal: SyncJournal
    let history: SyncHistoryStore
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


    private let protectedDataAvailable: () -> Bool

    init(directory suppliedDirectory: URL? = nil,
         protectedDataAvailable: @escaping () -> Bool = { UIApplication.shared.isProtectedDataAvailable }) {
        self.protectedDataAvailable = protectedDataAvailable
        let testing = ProcessInfo.processInfo.arguments.contains("--ui-testing")
        let directory = suppliedDirectory ?? URL.applicationSupportDirectory.appendingPathComponent(testing ? "HealthRelay-UITests" : "HealthRelay", isDirectory: true)
        let file = directory.appendingPathComponent("tasks.json")
        if testing && ProcessInfo.processInfo.arguments.contains("--reset-configurations") {
            try? FileManager.default.removeItem(at: directory)
        }
        repository = ConfigurationRepository(fileURL: file)
        backfillRepository = BackfillRepository(file: directory.appendingPathComponent("backfills.json"))
        history = SyncHistoryStore(file: directory.appendingPathComponent("history/history.sqlite"))
        journal = SyncJournal(directory: directory.appendingPathComponent("sync", isDirectory: true), history: history)
        loadConfiguration()
        #if DEBUG
        if configurationReady && tasks.isEmpty {
            do { if let fixture = try DebugFixture.install(repository: repository, credentials: credentials) { tasks = [fixture] } }
            catch { loadError = "真机验收配置创建失败：" + error.localizedDescription }
        }
        #endif
        #if DEBUG && targetEnvironment(simulator)
        if ProcessInfo.processInfo.arguments.contains("--synthetic-health"), configurationReady, tasks.isEmpty,
           let endpoint = ProcessInfo.processInfo.environment["HEALTHRELAY_ACCEPTANCE_ENDPOINT"],
           let key = ProcessInfo.processInfo.environment["HEALTHRELAY_ACCEPTANCE_KEY"] {
            var fixture = AutomationConfig.newTask()
            fixture.name = "合成数据链路验收"
            fixture.data.selections = [MetricSelection(typeIdentifier: "HKQuantityTypeIdentifierBodyMass", unit: "kg")]
            if ProcessInfo.processInfo.arguments.contains("--synthetic-aggregate") {
                fixture.export.mode = .aggregate; fixture.export.grouping = .hours
                fixture.data.selections.append(MetricSelection(typeIdentifier: "HKQuantityTypeIdentifierStepCount", unit: "count"))
            }
            if ProcessInfo.processInfo.arguments.contains("--synthetic-periodic") {
                fixture.enabled = true
                fixture.execution.onDataChange = false; fixture.execution.onForeground = false
                fixture.execution.periodicPolling = true; fixture.execution.minimumIntervalSeconds = 60
            }
            fixture.destination.url = endpoint; fixture.destination.acknowledgement = .receipt
            do {
                fixture.destination.headers = ["X-Acceptance-Key": key]
                try repository.save([fixture]); tasks = [fixture]
            } catch { loadError = "验收配置创建失败" }
        }
        #endif
        #if DEBUG && targetEnvironment(simulator)
        SyncHistoryUITestFixture.install(history, device: .iPhone)
        #endif
        for task in tasks { outcomes[task.id] = try? journal.load(task.id).logs.first }
    }

    private func loadConfiguration() {
        guard protectedDataAvailable() else { waitingForProtectedData = true; return }
        do {
            let loadedTasks = try repository.load()
            let loadedBackfills = try backfillRepository.load()
            tasks = loadedTasks; backfills = loadedBackfills
            waitingForProtectedData = false
            for task in tasks { outcomes[task.id] = try? journal.load(task.id).logs.first }
            journal.recoverHistory()
            for task in loadedTasks where task.device == .iPhone { try? journal.migrateHistory(task: task) }
            for job in loadedBackfills {
                try? journal.migrateHistory(task: job.task, journalID: job.id, context: SyncHistoryContext(task: job.task, journalID: job.id, kind: .backfill))
            }
        } catch {
            // A lock can occur between the availability check and the file read.
            if !protectedDataAvailable() { waitingForProtectedData = true }
            else { loadError = error.localizedDescription; waitingForProtectedData = false }
        }
    }

    @discardableResult
    func reloadProtectedConfiguration() -> Bool {
        guard waitingForProtectedData, loadError == nil else { return false }
        loadConfiguration()
        return configurationReady
    }

    func protectedDataDidBecomeAvailable() {
        let reloaded = reloadProtectedConfiguration()
        guard configurationReady else { return }
        if reloaded { startBackgroundServices() }
        Task { await runDue(trigger: "protectedData") }
    }

    func registerBackgroundRefresh() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: Self.refreshIdentifier, using: nil) { [weak self] task in
            Task { @MainActor in
                guard let self else { task.setTaskCompleted(success: false); return }
                let work = Task { await self.runDue(trigger: "background") }
                let completion = ObserverCompletion { task.setTaskCompleted(success: !work.isCancelled) }
                task.expirationHandler = {
                    work.cancel()
                    Task { @MainActor in
                        self.scheduleRecovery()
                        completion.call()
                    }
                }
                await work.value
                completion.call()
            }
        }
    }

    func save(_ task: AutomationConfig) throws {
        guard configurationReady else { throw ConfigurationError("本地配置未能读取，保存已停止以保护原文件") }
        try ensureEditable(task)
        guard try journal.load(task.id).pending == nil else { throw ConfigurationError("有待上传批次，请先重试完成后再修改配置") }
        var updated = tasks
        var candidate = task
        if let index = updated.firstIndex(where: { $0.id == task.id }) {
            candidate.revision = updated[index].revision + 1
            if candidate.device != updated[index].device { candidate.enabled = false }
            updated[index] = candidate
        } else { updated.append(candidate) }
        try repository.save(updated)
        tasks = updated
        Task { await configureObservers() }
    }

    func installHealthSignature(endpoint: String, key: String) throws {
        guard configurationReady, protectedDataAvailable() else { throw ConfigurationError("设备解锁后再创建同步任务") }
        guard !key.isEmpty, !AutomationConfig.containsHeaderLineBreak(key) else { throw ConfigurationError("请填写有效的服务认证值") }
        var incoming = try HealthSignaturePreset.configurations(endpoint: endpoint)
        guard !tasks.contains(where: { old in incoming.contains { $0.name == old.name && $0.destination.url == old.destination.url } }) else {
            throw ConfigurationError("此服务的健康签名任务已存在，请在任务列表检查")
        }
        var references: [String] = []
        do {
            for index in incoming.indices {
                let reference = try credentials.save(key); references.append(reference)
                incoming[index].destination.secretHeaders = ["X-Acceptance-Key": reference]
                incoming[index].destination.requiredSecretHeaders = nil
            }
            let updated = tasks + incoming
            try repository.save(updated)
            tasks = updated
        } catch {
            for reference in references { credentials.delete(reference) }
            throw error
        }
    }

    func importConfigurations(_ inspection: ConfigurationInspection) throws {
        guard configurationReady, protectedDataAvailable() else { throw ConfigurationError("本地配置未能读取，导入已停止以保护原文件") }
        let copies = try ConfigurationExchange.copiesForImport(inspection)
        let updated = tasks + copies
        if copies.contains(where: { $0.device == .watch }) {
            _ = try WatchConfigurationSnapshot(tasks: updated.filter { $0.device == .watch })
        }
        try repository.save(updated)
        tasks = updated
        Task { await configureObservers() }
    }

    func delete(_ task: AutomationConfig) throws {
        guard configurationReady else { throw ConfigurationError("本地配置未能读取") }
        try ensureEditable(task)
        guard try journal.load(task.id).pending == nil else { throw ConfigurationError("有待上传批次，请先完成后再删除") }
        let updated = tasks.filter { $0.id != task.id }
        try repository.save(updated)
        tasks = updated
        try journal.remove(task.id)
        removeCredentials(task)
        Task { await configureObservers() }
    }

    func checkRead(_ task: AutomationConfig) async throws -> String {
        try requirePhone(task)
        guard active.insert(task.id).inserted else { throw ConfigurationError("任务正在运行") }
        defer { active.remove(task.id) }
        await coordinator.acquire()
        defer { coordinator.release() }
        try Task.checkCancellation()
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
        guard configurationReady else { throw ConfigurationError("本地配置暂不可读") }
        try requirePhone(task)
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

    func executionStartIssues(_ task: AutomationConfig) -> [String] {
        do {
            return task.executionStartIssues(pending: try journal.load(task.id).pending,
                systemMajorVersion: ProcessInfo.processInfo.operatingSystemVersion.majorVersion)
        } catch { return ["同步状态无法读取，已停止以保护原文件"] }
    }

    func run(_ task: AutomationConfig, automatic: Bool = false, trigger: String = "manual", deadline: Date? = nil) async {
        do { try requirePhone(task) }
        catch { outcomes[task.id] = RunLog(state: .failed, message: error.localizedDescription); return }
        guard active.insert(task.id).inserted else { return }
        defer { active.remove(task.id); scheduleRefresh() }
        await coordinator.acquire()
        defer { coordinator.release() }
        guard !Task.isCancelled, deadline.map({ $0 > Date() }) ?? true else { return }
        var dirtyAtStart = Set(UserDefaults.standard.stringArray(forKey: dirtyKey) ?? [])
        dirtyAtStart.remove(task.id.uuidString)
        UserDefaults.standard.set(Array(dirtyAtStart), forKey: dirtyKey)
        outcomes[task.id] = RunLog(state: .running, message: "正在读取并上传")
        do {
            let previous: SyncState
            do { previous = try journal.load(task.id) }
            catch { throw ConfigurationError("同步状态无法读取，已停止以保护原文件") }
            let issues = task.executionStartIssues(pending: previous.pending, automatic: automatic,
                systemMajorVersion: ProcessInfo.processInfo.operatingSystemVersion.majorVersion)
            guard issues.isEmpty else { throw ConfigurationError(issues.joined(separator: "；")) }
            if !automatic && trigger != "shortcut" && previous.pending == nil {
                #if DEBUG && targetEnvironment(simulator)
                if !ProcessInfo.processInfo.arguments.contains("--synthetic-health") { try await health.authorize(task) }
                #else
                try await health.authorize(task)
                #endif
            }
            #if DEBUG
            reportExecution("runStart", task: task, trigger: trigger)
            #endif
            let outcome = await engine.run(task, automatic: automatic, timeBudget: deadline.map { max(0, $0.timeIntervalSinceNow) } ?? 25, trigger: trigger)
            #if DEBUG
            reportExecution("runFinish", task: task, trigger: trigger, outcome: outcome)
            #endif
            outcomes[task.id] = outcome
            if outcome.state == .failed || outcome.state == .queued { markDirty(task.id) }
            if automatic && ((outcome.state == .failed && (task.execution.notifyOnFailure ?? true)) || (outcome.state == .succeeded && task.execution.notifyOnSuccess == true)) {
                let content = UNMutableNotificationContent(); content.title = "HealthRelay · \(task.name)"; content.body = outcome.message
                try? await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: task.id.uuidString, content: content, trigger: nil))
            }
        } catch {
            outcomes[task.id] = RunLog(state: .failed, message: (error as? ConfigurationError)?.message ?? "健康数据暂不可读，请解锁并检查健康读取权限")
            journal.recordRunFailure(context: SyncHistoryContext(task: task), message: outcomes[task.id]!.message)
            markDirty(task.id)
        }
    }

    private func markDirty(_ id: UUID) {
        var dirty = Set(UserDefaults.standard.stringArray(forKey: dirtyKey) ?? [])
        dirty.insert(id.uuidString); UserDefaults.standard.set(Array(dirty), forKey: dirtyKey)
    }

    func cancelPending(_ task: AutomationConfig) throws {
        guard !active.contains(task.id) else { throw ConfigurationError("任务正在运行") }
        guard let pending = try journal.load(task.id).pending else { return }
        let identity = BatchIdentity(taskID: task.id, batchID: pending.batchID, fingerprint: pending.configurationFingerprint)
        _ = try journal.discard(identity)
        outcomes[task.id] = try journal.load(task.id).logs.first; markDirty(task.id); scheduleRefresh()
    }

    private func ensureEditable(_ task: AutomationConfig) throws {
        guard !active.contains(task.id) else { throw ConfigurationError("任务正在运行，请完成后再修改") }
        guard !backfills.contains(where: { $0.task.id == task.id && $0.completedAt == nil }) else {
            throw ConfigurationError("请先完成或取消历史补传，再修改或删除原任务")
        }
    }

    func startBackfill(_ task: AutomationConfig, start: Date, end: Date) async throws {
        try requirePhone(task)
        try ensureEditable(task)
        let job = try BackfillJob(task: task, start: start, end: end)
        #if DEBUG && targetEnvironment(simulator)
        if !ProcessInfo.processInfo.arguments.contains("--synthetic-health") { try await health.authorize(task) }
        #else
        try await health.authorize(task)
        #endif
        let updated = backfills + [job]
        try backfillRepository.save(updated); backfills = updated
        await runBackfill(job)
    }

    func runBackfill(_ job: BackfillJob, automatic: Bool = false, deadline: Date? = nil) async {
        guard canRunOnPhone(job.task), job.completedAt == nil, active.insert(job.id).inserted else { return }
        defer { active.remove(job.id); scheduleRefresh() }
        await coordinator.acquire()
        defer { coordinator.release() }
        guard !Task.isCancelled, deadline.map({ $0 > Date() }) ?? true else { return }
        outcomes[job.id] = RunLog(state: .running, message: "正在补传历史数据")
        let log = await engine.run(job.task, automatic: automatic,
            timeBudget: deadline.map { max(0, $0.timeIntervalSinceNow) } ?? 25,
            storageID: job.id, trigger: "backfill")
        outcomes[job.id] = log
        if log.state == .succeeded || log.state == .noData,
           let index = backfills.firstIndex(where: { $0.id == job.id }) {
            var updated = backfills; updated[index].completedAt = Date()
            do { try backfillRepository.save(updated); backfills = updated }
            catch { outcomes[job.id] = RunLog(state: .failed, message: "补传完成状态保存失败，可安全重试") }
        }
    }

    func removeBackfill(_ job: BackfillJob) throws {
        guard !active.contains(job.id) else { throw ConfigurationError("补传正在运行，请完成本批后再取消") }
        let updated = backfills.filter { $0.id != job.id }
        try backfillRepository.save(updated); backfills = updated
        try journal.remove(job.id)
        outcomes[job.id] = nil
        scheduleRefresh()
    }

    func runDue(dataChangeOnly: Bool = false, trigger: String = "foreground") async {
        guard configurationReady, !checkingDue else { return }
        checkingDue = true
        defer { checkingDue = false; scheduleRefresh() }
        let deadline = Date().addingTimeInterval(25)
        // Daily exports and backfills share one age-ordered queue.
        let candidates = tasks.filter { $0.enabled && canRunOnPhone($0) }.map { (id: $0.id, task: $0, job: Optional<BackfillJob>.none) }
            + backfills.filter { $0.completedAt == nil && canRunOnPhone($0.task) }.map { (id: $0.id, task: $0.task, job: Optional($0)) }
        let ordered = candidates.sorted {
            ((try? journal.load($0.id).lastAttempt) ?? .distantPast) < ((try? journal.load($1.id).lastAttempt) ?? .distantPast)
        }
        for candidate in ordered {
            guard !Task.isCancelled, Date() < deadline else { break }
            guard let state = try? journal.load(candidate.id) else { continue }
            let dirty = Set(UserDefaults.standard.stringArray(forKey: dirtyKey) ?? [])
            guard let due = AutomationSchedule.nextDate(candidate.task.execution, state: state,
                dirty: dirty.contains(candidate.id.uuidString),
                foregroundCheck: !dataChangeOnly && trigger == "foreground", periodicCheck: !dataChangeOnly,
                backfill: candidate.job != nil, now: Date()), due <= Date() else { continue }
            if let job = candidate.job { await runBackfill(job, automatic: true, deadline: deadline) }
            else { await run(candidate.task, automatic: true, trigger: dataChangeOnly ? "healthChange" : trigger, deadline: deadline) }
        }
    }

    // Install queries synchronously before HealthKit can deliver launch updates.
    func startBackgroundServices() {
        guard configurationReady else { return }
        installObservers()
        Task { await configureBackgroundDelivery() }
    }

    func configureObservers() async {
        guard configurationReady else { return }
        installObservers()
        await configureBackgroundDelivery()
    }

    private func installObservers() {
        for query in observers { health.health.stop(query) }; observers = []
        let identifiers = Set(tasks.filter { $0.enabled && canRunOnPhone($0) && $0.execution.onDataChange }.flatMap { $0.data.selections.map(\.id) })
        for id in identifiers {
            guard let type = try? health.sampleType(id) else { continue }
            let query = HKObserverQuery(sampleType: type, predicate: nil) { [weak self] _, complete, error in
                let completion = ObserverCompletion(complete)
                Task { @MainActor in
                    guard let self, error == nil else { completion.call(); return }
                    ObserverWork.start(completion: completion, onTimeout: { self.scheduleRecovery() }) {
                        var dirty = Set(UserDefaults.standard.stringArray(forKey: self.dirtyKey) ?? [])
                        for task in self.tasks where self.canRunOnPhone(task) && task.enabled && task.execution.onDataChange && task.data.selections.contains(where: { $0.id == id }) { dirty.insert(task.id.uuidString) }
                        UserDefaults.standard.set(Array(dirty), forKey: self.dirtyKey)
                        self.scheduleRefresh()
                        await self.runDue(dataChangeOnly: true)
                    }
                }
            }
            observers.append(query); health.health.execute(query)
        }
    }

    private func configureBackgroundDelivery() async {
        await observerCoordinator.acquire()
        defer { observerCoordinator.release() }
        guard configurationReady else { return }
        await withCheckedContinuation { continuation in
            health.health.disableAllBackgroundDelivery { _, _ in continuation.resume() }
        }
        let identifiers = Set(tasks.filter { $0.enabled && canRunOnPhone($0) && $0.execution.onDataChange }.flatMap { $0.data.selections.map(\.id) })
        for id in identifiers {
            guard let type = try? health.sampleType(id) else { continue }
            do { try await health.health.enableBackgroundDelivery(for: type, frequency: .immediate) }
            catch {
                for task in tasks where task.data.selections.contains(where: { $0.id == id }) && task.enabled {
                    outcomes[task.id] = RunLog(state: .failed, message: "此类型的后台通知未能启用，仍可手动运行；请检查签名能力")
                }
            }
        }
        #if DEBUG
        reportObserverStartup("observersConfigured")
        #endif
        await configureReminders()
        scheduleRefresh()
    }

    #if DEBUG
    private func reportExecution(_ phase: String, task: AutomationConfig, trigger: String, outcome: RunLog? = nil) {
        guard ProcessInfo.processInfo.arguments.contains("--diagnose-background") else { return }
        let pending = (try? journal.load(task.id))?.pending?.batchID ?? "none"
        print("HEALTHRELAY_BACKGROUND_DIAGNOSTIC phase=\(phase) time=\(Date().ISO8601Format()) task=\(task.id) trigger=\(trigger) appState=\(UIApplication.shared.applicationState.rawValue) result=\(outcome?.state.rawValue ?? "running") status=\(outcome?.httpStatus ?? 0) records=\(outcome?.records ?? 0) pending=\(pending)")
    }

    func reportObserverStartup(_ phase: String) {
        guard ProcessInfo.processInfo.arguments.contains("--diagnose-background") else { return }
        let expected = Set(tasks.filter { $0.enabled && canRunOnPhone($0) && $0.execution.onDataChange }.flatMap { $0.data.selections.map(\.id) }).count
        print("HEALTHRELAY_BACKGROUND_DIAGNOSTIC phase=\(phase) observers=\(observers.count) expected=\(expected) appState=\(UIApplication.shared.applicationState.rawValue)")
    }
    #endif

    func configureReminders() async {
        guard configurationReady else { return }
        await reminderCoordinator.acquire()
        defer { reminderCoordinator.release() }
        do { try await reminders.replace(tasks: tasks); reminderError = nil }
        catch { reminderError = "提醒未能安排，请检查通知权限后重新保存任务。" }
    }

    func openReminder(_ id: UUID, run: Bool) async {
        guard let task = tasks.first(where: { $0.id == id }), task.enabled, !active.contains(id) else {
            reminderRoute = ReminderRoute(taskID: nil); return
        }
        reminderRoute = ReminderRoute(taskID: id)
        if run { await self.run(task, trigger: "reminder") }
    }

    func setForegroundActive(_ active: Bool) {
        guard foregroundActive != active else { return }
        foregroundActive = active
        if active && reloadProtectedConfiguration() { startBackgroundServices() }
        if active { journal.recoverHistory() }
        scheduleRefresh()
        if active { Task { await runDue() } }
    }

    private func scheduleRecovery() {
        guard tasks.contains(where: \.enabled) || backfills.contains(where: { $0.completedAt == nil }) else { return }
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: Self.refreshIdentifier)
        let request = BGAppRefreshTaskRequest(identifier: Self.refreshIdentifier)
        request.earliestBeginDate = Date().addingTimeInterval(60)
        try? BGTaskScheduler.shared.submit(request)
    }

    private func scheduleRefresh() {
        foregroundWake?.cancel(); foregroundWake = nil
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: Self.refreshIdentifier)
        guard configurationReady else { return }
        let now = Date()
        let dirty = Set(UserDefaults.standard.stringArray(forKey: dirtyKey) ?? [])
        var dates = tasks.filter { $0.enabled && canRunOnPhone($0) }.compactMap { task -> Date? in
            if active.contains(task.id) { return now.addingTimeInterval(60) }
            guard let state = try? journal.load(task.id) else { return now.addingTimeInterval(300) }
            return AutomationSchedule.nextDate(task.execution, state: state,
                dirty: dirty.contains(task.id.uuidString), now: now)
        }
        for job in backfills where job.completedAt == nil && canRunOnPhone(job.task) {
            if active.contains(job.id) { dates.append(now.addingTimeInterval(60)); continue }
            if let state = try? journal.load(job.id),
               let due = AutomationSchedule.nextDate(job.task.execution, state: state, backfill: true, now: now) {
                dates.append(due)
            }
        }
        guard let earliest = dates.min() else { return }
        if foregroundActive {
            let delay = max(1, earliest.timeIntervalSince(now))
            foregroundWake = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(delay)) } catch { return }
                guard let self, self.foregroundActive, !Task.isCancelled else { return }
                self.foregroundWake = nil
                await self.runDue(trigger: "interval")
            }
        }
        let request = BGAppRefreshTaskRequest(identifier: Self.refreshIdentifier)
        request.earliestBeginDate = max(now.addingTimeInterval(60), earliest)
        try? BGTaskScheduler.shared.submit(request)
    }

    func canRunOnPhone(_ task: AutomationConfig) -> Bool {
        task.device == .iPhone && watchSync.canExecutePhoneTasks && !watchSync.possibleWatchIDs.contains(task.id)
    }
    private func requirePhone(_ task: AutomationConfig) throws {
        guard canRunOnPhone(task) else { throw ConfigurationError("此任务由 Watch 执行；切回 iPhone 后请同步 Watch 配置，等待 Watch 确认移除后再运行") }
    }
    func syncWatch() throws {
        guard configurationReady else { throw ConfigurationError("本地配置暂不可读") }
        try watchSync.sync(tasks: tasks.filter { $0.device == .watch })
    }

    func removeCredentials(_ task: AutomationConfig) {
        if let ref = task.destination.credentialRef { credentials.delete(ref) }
        for ref in task.destination.secretHeaders?.values ?? Dictionary<String, String>().values { credentials.delete(ref) }
    }
}
