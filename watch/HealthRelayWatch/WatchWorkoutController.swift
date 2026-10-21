import Foundation
import Observation
import HealthKit
import HealthRelayCore

@MainActor @Observable final class WatchWorkoutController: NSObject, HKWorkoutSessionDelegate, HKLiveWorkoutBuilderDelegate {
    static let shared = WatchWorkoutController()
    static let uploadIdentifier = "org.healthrelay.app.watch.workout-uploads"
    private(set) var starting = false
    private(set) var running = false
    private(set) var paused = false
    private(set) var finishing = false
    private(set) var heartRate: Double?
    private(set) var heartMeasuredAt: Date?
    private(set) var status = "开始真实运动后，每分钟尝试发送一次"
    private(set) var lastConfirmedAt: Date?
    private var session: HKWorkoutSession?
    private var builder: HKLiveWorkoutBuilder?
    private var startedAt: Date?
    private var endedAt: Date?
    private var collectionEnded = false
    private var ticker: Task<Void, Never>?
    private var uploading = false
    private var recovering = false
    private var savingWorkout = false
    private let health = HKHealthStore()
    private let outbox: WorkoutRelayOutbox
    let uploader: BackgroundUploader
    override init() {
        let directory = URL.applicationSupportDirectory.appendingPathComponent("HealthRelayWorkout")
        outbox = WorkoutRelayOutbox(directory: directory, history: WatchHistoryStorage.shared)
        uploader = BackgroundUploader(directory: directory.appendingPathComponent("uploads"),
            credentials: CredentialStore(), identifier: Self.uploadIdentifier)
        super.init()
        outbox.recoverHistory()
        let journal = outbox.journal
        uploader.onStart = { identity, attempt, date in
            guard try journal.markSending(identity, attemptID: attempt, at: date) else { throw ConfigurationError("运动批次已变更") }
        }
        uploader.onCompletion = { [weak self] in Task { await self?.retryUploads() } }
        uploader.connect()
    }
    var hasUnsentRecords: Bool { (try? outbox.hasUnsentRecords()) ?? true }
    var needsFinish: Bool { session != nil && !running }
    var configurationLocked: Bool { starting || recovering || session != nil || hasUnsentRecords }
    var nextUploadDate: Date? {
        guard hasUnsentRecords else { return nil }
        if let task = try? outbox.task(), let pending = try? outbox.journal.load(task.id).pending {
            return pending.automaticRetry ? pending.nextAttempt ?? Date().addingTimeInterval(60) : nil
        }
        return Date().addingTimeInterval(60)
    }
    func elapsed(at date: Date) -> TimeInterval { builder?.elapsedTime(at: date) ?? 0 }
    func start(task: AutomationConfig, activity: HKWorkoutActivityType) async {
        guard session == nil, !starting, !recovering, !finishing else { return }
        starting = true; defer { starting = false }
        do {
            guard task.device == .watch, task.enabled, task.executionIssues.isEmpty,
                  task.data.selections.contains(where: { $0.id == "HKWorkoutType" }) else { throw ConfigurationError("请先配置并启用 Watch 锻炼同步任务") }
            guard try !outbox.hasUnsentRecords() else { throw ConfigurationError("上次运动仍有待传数据，请先重试上传") }
            try await health.requestAuthorization(toShare: [HKObjectType.workoutType()], read: [
                HKObjectType.workoutType(), HKQuantityType(.heartRate), HKQuantityType(.activeEnergyBurned)])
            let configuration = HKWorkoutConfiguration(); configuration.activityType = activity; configuration.locationType = .indoor
            let session = try HKWorkoutSession(healthStore: health, configuration: configuration)
            let builder = session.associatedWorkoutBuilder()
            var binding = task; binding.id = UUID(); binding.name = "Watch 运动实时摘要"
            try outbox.begin(task: binding, historyTaskID: task.id)
            self.session = session; self.builder = builder
            session.delegate = self; builder.delegate = self
            builder.dataSource = HKLiveWorkoutDataSource(healthStore: health, workoutConfiguration: configuration)
            let start = Date(); startedAt = start; endedAt = nil; collectionEnded = false
            session.startActivity(with: start)
            do { try await builder.beginCollection(at: start) }
            catch { session.end(); self.session = nil; self.builder = nil; startedAt = nil; throw error }
            running = true; paused = false; heartRate = nil; heartMeasuredAt = nil
            status = "正在记录运动；每分钟尝试发送"
            startTicker()
        } catch { status = error.localizedDescription }
    }
    func togglePause() {
        guard let session, !finishing else { return }
        if paused { session.resume() } else { session.pause() }
    }
    func stop() {
        guard let session, !finishing else { return }
        finishing = true; ticker?.cancel(); ticker = nil; status = "正在结束并保存运动"
        if session.state == .ended { Task { await finish(at: endedAt ?? Date()) } }
        else { session.end() }
    }
    func recover() {
        guard session == nil, !starting, !recovering else { return }
        recovering = true
        health.recoverActiveWorkoutSession { [weak self] recovered, _ in
            Task { @MainActor in
                guard let self else { return }
                self.recovering = false
                guard let recovered, self.session == nil else { return }
                let builder = recovered.associatedWorkoutBuilder()
                guard let start = builder.startDate else { self.status = "运动恢复失败，请在系统中结束该运动后重试"; return }
                self.session = recovered; self.builder = builder; self.startedAt = start
                recovered.delegate = self; builder.delegate = self
                self.running = true; self.paused = recovered.state == .paused
                self.status = "已恢复正在进行的运动"; self.startTicker()
            }
        }
    }
    private func startTicker() {
        ticker?.cancel()
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, self.running, !self.finishing else { return }
                await self.captureAndUpload()
                do { try await Task.sleep(for: .seconds(60)) } catch { return }
            }
        }
    }
    private func observation(at date: Date, state: WorkoutLiveSample.State) throws -> WorkoutLiveSample {
        guard let task = try outbox.task(), let start = startedAt, let session else { throw ConfigurationError("运动会话不可用") }
        return WorkoutLiveSample(sessionID: task.id, start: start, observedAt: date,
            elapsedSeconds: elapsed(at: date), activityType: session.workoutConfiguration.activityType.rawValue,
            state: state, heartRate: heartRate, heartMeasuredAt: heartMeasuredAt)
    }
    private func captureAndUpload() async {
        guard running, !finishing else { return }
        do {
            let sample = try observation(at: Date(), state: paused ? .paused : .running)
            try outbox.offer([sample.record()], terminal: false)
            await retryUploads()
        } catch { status = "摘要保留待重试：" + error.localizedDescription }
    }
    func retryUploads(manual: Bool = false) async {
        guard !uploading else { return }
        uploading = true; defer { uploading = false }
        do {
            for (file, result) in try uploader.storedCompletions() {
                do {
                    if let failure = result.failure { throw UploadFailure(failure, retryable: result.retryable, status: result.status) }
                    guard let code = result.status else { throw UploadFailure("服务响应无效", retryable: true) }
                    if try outbox.confirm(result.identity, status: code, data: result.body,
                        now: result.completedAt ?? Date(), completionID: result.completionID, attemptID: result.attemptID,
                        confirmationTimeKnown: result.completedAt != nil) {
                        lastConfirmedAt = result.completedAt ?? Date(); status = running ? "摘要已到达服务，运动继续记录" : "运动记录已到达服务"
                    }
                } catch let failure as UploadFailure {
                    var failure = failure; failure.retryAfter = HTTPAcknowledgement.retryDelay(result.retryAfter)
                    try outbox.fail(result.identity, failure: failure, now: result.completedAt ?? Date(), completionID: result.completionID, attemptID: result.attemptID); status = "上传失败，数据已保留等待重试"
                }
                try uploader.consumed(file, identity: result.identity)
            }
            if let task = try outbox.task(), let pending = try outbox.prepare(automatic: !manual) {
                do { try await uploader.enqueue(task: task, pending: pending) }
                catch {
                    let identity = BatchIdentity(taskID: task.id, batchID: pending.batchID, fingerprint: pending.configurationFingerprint)
                    try outbox.fail(identity, failure: (error as? UploadFailure) ?? UploadFailure("运动后台传输未能排队，批次保留", retryable: true))
                    throw error
                }
                status = "已交给系统传输，等待服务确认"
            }
        } catch { status = "待传记录已保留：" + error.localizedDescription }
    }
    private func finish(at date: Date) async {
        guard let builder, !savingWorkout else { return }
        savingWorkout = true; defer { savingWorkout = false }
        endedAt = date
        ticker?.cancel(); ticker = nil; running = false; finishing = true
        do {
            let sample = try observation(at: date, state: .ended)
            // Persist an ended observation before asking HealthKit to save the final workout.
            try outbox.offer([sample.record()], terminal: false)
            if !collectionEnded { try await builder.endCollection(at: date); collectionEnded = true }
            guard let workout = try await builder.finishWorkout() else { throw ConfigurationError("健康记录保存未完成") }
            let record = try HealthKitReader().record(workout, unit: nil)
            try outbox.offer(sample.replacing(with: record), terminal: true)
            session = nil; self.builder = nil; startedAt = nil; finishing = false; paused = false
            status = "运动已保存，正在确认上传"; await retryUploads()
        } catch { finishing = false; status = "运动保存未完成，请重试结束：" + error.localizedDescription }
    }
    nonisolated func workoutSession(_ workoutSession: HKWorkoutSession, didChangeTo toState: HKWorkoutSessionState,
                                  from fromState: HKWorkoutSessionState, date: Date) {
        Task { @MainActor in
            guard session === workoutSession else { return }
            paused = toState == .paused
            if toState == .ended { await finish(at: date) }
        }
    }
    nonisolated func workoutSession(_ workoutSession: HKWorkoutSession, didFailWithError error: any Error) {
        Task { @MainActor in guard session === workoutSession else { return }; ticker?.cancel(); running = false; finishing = false; status = "运动会话异常，请结束后重试：" + error.localizedDescription }
    }
    nonisolated func workoutBuilderDidCollectEvent(_ workoutBuilder: HKLiveWorkoutBuilder) {}
    nonisolated func workoutBuilder(_ workoutBuilder: HKLiveWorkoutBuilder, didCollectDataOf collectedTypes: Set<HKSampleType>) {
        guard collectedTypes.contains(HKQuantityType(.heartRate)), let stats = workoutBuilder.statistics(for: HKQuantityType(.heartRate)),
              let quantity = stats.mostRecentQuantity(), let interval = stats.mostRecentQuantityDateInterval() else { return }
        let value = quantity.doubleValue(for: HKUnit.count().unitDivided(by: .minute())), date = interval.end
        Task { @MainActor in if value.isFinite && value > 0 { heartRate = value; heartMeasuredAt = date } }
    }
}
