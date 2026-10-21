import Foundation

/// A real in-progress workout observation. No HRV or heart rate is synthesized.
public struct WorkoutLiveSample: Sendable {
    public enum State: String, Codable, Sendable { case running, paused, ended }
    public var sessionID: UUID
    public var start: Date
    public var observedAt: Date
    public var elapsedSeconds: Double
    public var activityType: UInt
    public var state: State
    public var heartRate: Double?
    public var heartMeasuredAt: Date?
    public init(sessionID: UUID, start: Date, observedAt: Date, elapsedSeconds: Double, activityType: UInt,
                state: State, heartRate: Double? = nil, heartMeasuredAt: Date? = nil) {
        self.sessionID = sessionID; self.start = start; self.observedAt = observedAt
        self.elapsedSeconds = elapsedSeconds; self.activityType = activityType; self.state = state
        self.heartRate = heartRate; self.heartMeasuredAt = heartMeasuredAt
    }
    public var recordID: String { "healthrelay-live-workout:" + sessionID.uuidString.lowercased() }
    public func record() throws -> HealthRecord {
        guard observedAt >= start, elapsedSeconds.isFinite, elapsedSeconds >= 0,
              elapsedSeconds <= observedAt.timeIntervalSince(start) + 1 else { throw ConfigurationError("运动时长无效") }
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var live: [String: JSONValue] = ["version": .number(1), "state": .string(state.rawValue)]
        if let heartRate, let measured = heartMeasuredAt {
            guard heartRate.isFinite, heartRate > 0, measured >= start, measured <= observedAt else { throw ConfigurationError("运动心率时间无效") }
            live["heartRate"] = .object(["value": .number(heartRate), "unit": .string("count/min"),
                "measuredAt": .string(formatter.string(from: measured))])
        }
        return HealthRecord(op: .upsert, typeIdentifier: "HKWorkoutType", recordId: recordID,
            start: formatter.string(from: start), end: formatter.string(from: observedAt),
            source: RecordSource(id: "org.healthrelay.watch.live", name: "HealthRelay Apple Watch", device: "Watch"),
            payload: ["activityType": .number(Double(activityType)), "durationSeconds": .number(elapsedSeconds), "live": .object(live)])
    }
    public func replacing(with completed: HealthRecord) -> [HealthRecord] {
        var completed = completed
        if let provisional = try? record(), case .object(var live)? = provisional.payload?["live"] {
            live["state"] = .string("ended")
            if completed.payload == nil { completed.payload = [:] }
            completed.payload?["live"] = .object(live)
        }
        return [HealthRecord(op: .delete, typeIdentifier: "HKWorkoutType", recordId: recordID), completed]
    }
}

/// One durable in-flight batch and one coalesced latest observation. A newer final
/// replacement never overwrites an unacknowledged batch and survives process death.
@MainActor public final class WorkoutRelayOutbox {
    private struct Latest: Codable { var id = UUID(); var records: [HealthRecord]; var terminal: Bool }
    private let directory: URL
    public let journal: SyncJournal
    public init(directory: URL, history: SyncHistoryStore? = nil) {
        self.directory = directory
        journal = SyncJournal(directory: directory.appendingPathComponent("journal"), history: history)
    }
    private var binding: URL { directory.appendingPathComponent("binding.json") }
    private var latestFile: URL { directory.appendingPathComponent("latest.json") }
    private var historyBinding: URL { directory.appendingPathComponent("history-context.json") }
    private func read<T: Decodable>(_ type: T.Type, _ file: URL) throws -> T? {
        guard FileManager.default.fileExists(atPath: file.path) else { return nil }
        return try JSONDecoder().decode(type, from: Data(contentsOf: file))
    }
    private func write<T: Encodable>(_ value: T, _ file: URL) throws {
        let bytes = try JSONEncoder().encode(value)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        #if os(iOS) || os(watchOS)
        try bytes.write(to: file, options: [.atomic, .completeFileProtection])
        #else
        try bytes.write(to: file, options: .atomic)
        #endif
    }
    public func task() throws -> AutomationConfig? { try read(AutomationConfig.self, binding) }
    public func hasUnsentRecords() throws -> Bool {
        if try read(Latest.self, latestFile) != nil { return true }
        guard let task = try task() else { return false }
        return try journal.load(task.id).pending != nil
    }
    public func begin(task: AutomationConfig, historyTaskID: UUID? = nil) throws {
        guard try !hasUnsentRecords() else { throw ConfigurationError("上次运动仍有待传数据，请先联网重试") }
        guard task.device == .watch, task.export.format == "healthrelay.v1", task.destination.acknowledgement == .receipt,
              task.validationIssues(device: .watch).isEmpty else { throw ConfigurationError("请选择原生回执模式的 Watch 锻炼任务") }
        try write(task, binding)
        try write(SyncHistoryContext(task: task, kind: .workout, originTaskID: historyTaskID), historyBinding)
    }
    public func offer(_ records: [HealthRecord], terminal: Bool) throws {
        guard try task() != nil, !records.isEmpty, records.count <= 2 else { throw ConfigurationError("运动上传尚未配置") }
        if let latest = try read(Latest.self, latestFile), latest.terminal && !terminal { throw ConfigurationError("运动已结束，不能覆盖结束记录") }
        try write(Latest(records: records, terminal: terminal), latestFile)
    }
    public func prepare(now: Date = Date(), automatic: Bool = true) throws -> PendingUpload? {
        guard let task = try task() else { return nil }
        var state = try journal.load(task.id)
        if let pending = state.pending {
            return !automatic || (pending.automaticRetry && (pending.nextAttempt ?? .distantPast) <= now) ? pending : nil
        }
        guard let latest = try read(Latest.self, latestFile) else { return nil }
        let batch = UploadBatch(task: task, records: latest.records)
        let encoded = try BatchEncoder.encode(batch)
        var pending = PendingUpload(batchID: batch.batchId, body: encoded.body, contentType: encoded.contentType,
            recordCount: batch.records.count, checkpointKey: "live:" + latest.id.uuidString,
            checkpoint: TypeCheckpoint(start: now), configurationFingerprint: try SyncIdentity.fingerprint(task))
        let saved = try read(SyncHistoryContext.self, historyBinding)
        let context = saved?.journalID == task.id ? saved! : SyncHistoryContext(task: task, kind: .workout)
        pending.history = SyncHistoryMetadata(context: context, summary: SyncHistorySummary(records: latest.records), queuedAt: now)
        state.pending = pending; state.lastAttempt = now
        journal.appendHistory(.queued, pending: pending, to: &state, at: now, eventID: pending.batchID + ":queued")
        try journal.save(state, for: task.id)
        return pending
    }
    @discardableResult public func confirm(_ identity: BatchIdentity, status: Int, data: Data, now: Date = Date(), completionID: String? = nil, attemptID: String? = nil, confirmationTimeKnown: Bool = true) throws -> Bool {
        guard let task = try task(), let pending = try journal.load(task.id).pending else { return false }
        let confirmed = try journal.confirm(identity, task: task, status: status, data: data, now: now, completionID: completionID, attemptID: attemptID, confirmationTimeKnown: confirmationTimeKnown)
        if confirmed, let latest = try read(Latest.self, latestFile), pending.checkpointKey == "live:" + latest.id.uuidString {
            try FileManager.default.removeItem(at: latestFile)
        }
        return confirmed
    }
    public func fail(_ identity: BatchIdentity, failure: UploadFailure, now: Date = Date(), completionID: String? = nil, attemptID: String? = nil) throws {
        _ = try journal.recordFailure(identity, failure: failure, now: now, completionID: completionID, attemptID: attemptID)
    }
    public func recoverHistory() {
        journal.recoverHistory()
        guard journal.history != nil, let task = try? task(),
              let files = try? FileManager.default.contentsOfDirectory(at: journal.directory, includingPropertiesForKeys: nil) else { return }
        for file in files where file.pathExtension == "json" {
            guard let id = UUID(uuidString: file.deletingPathExtension().lastPathComponent) else { continue }
            var oldTask = task; oldTask.id = id; oldTask.name = "Watch 运动实时摘要"
            let saved = try? read(SyncHistoryContext.self, historyBinding)
            let context = saved?.journalID == id ? saved : SyncHistoryContext(task: oldTask, kind: .legacy)
            try? journal.migrateHistory(task: oldTask, context: context)
        }
    }
}
