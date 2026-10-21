import Foundation
import CryptoKit

public struct TypeCheckpoint: Codable, Sendable {
    public var start: Date
    public var end: Date?
    public var anchor: Data?
    public var aggregate: AggregateState?
    public init(start: Date, end: Date? = nil, anchor: Data? = nil) { self.start = start; self.end = end; self.anchor = anchor }
}
public struct PendingUpload: Codable, Sendable {
    public var batchID: String
    public var body: Data
    public var contentType: String
    public var recordCount: Int
    public var checkpointKey: String
    public var checkpoint: TypeCheckpoint
    public var configurationFingerprint: String
    public var headers: [String: String]?
    public var history: SyncHistoryMetadata?
    public var attempts = 0
    public var nextAttempt: Date?
    public var automaticRetry = true
}
public struct RunLog: Codable, Identifiable, Sendable {
    public enum State: String, Codable, Sendable { case running, succeeded, noData, queued, failed }
    public var id = UUID()
    public var date = Date()
    public var state: State
    public var message: String
    public var records = 0
    public var batches = 0
    public var trigger: String?
    public var durationSeconds: Double?
    public var metricCounts: [String: Int]?
    public var omittedDeletions: Int?
    public var httpStatus: Int?
    public var historyRecorded: Bool?
    public init(state: State, message: String, records: Int = 0, batches: Int = 0, httpStatus: Int? = nil) {
        self.state = state; self.message = message; self.records = records; self.batches = batches; self.httpStatus = httpStatus
    }
}
public struct SyncState: Codable, Sendable {
    public var schemaVersion = 1
    public var nextSelectionID: String?
    public var cycleStartedAt: Date?
    public var cycleFingerprint: String?
    public var checkpoints: [String: TypeCheckpoint] = [:]
    public var pending: PendingUpload?
    public var lastAttempt: Date?
    public var lastConfirmedAt: Date?
    public var logs: [RunLog] = []
    public var historyEvents: [SyncHistoryEvent]?
    public init() {}
}
/// One bounded outbox and its proposed checkpoint share one atomic file.
/// The committed checkpoint advances only after the batch acknowledgement.
@MainActor public final class SyncJournal {
    public let directory: URL
    public let history: SyncHistoryStore?
    public private(set) var historyError: String?
    public init(directory: URL, history: SyncHistoryStore? = nil) { self.directory = directory; self.history = history }
    public func load(_ id: UUID) throws -> SyncState {
        let url = file(id)
        guard FileManager.default.fileExists(atPath: url.path) else { return SyncState() }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            guard let date = AutomationConfig.parseDate(text) else { throw ConfigurationError("同步状态时间无效") }
            return date
        }
        var state = try decoder.decode(SyncState.self, from: Data(contentsOf: url))
        guard state.schemaVersion == 1 else { throw ConfigurationError("不支持的同步状态版本") }
        if state.lastConfirmedAt == nil {
            state.lastConfirmedAt = state.logs.first { $0.state == .succeeded && $0.records > 0 }?.date
        }
        projectHistory(&state, id: id)
        return state
    }
    public func save(_ state: SyncState, for id: UUID) throws {
        var state = state
        state.logs = Array(state.logs.filter { $0.date >= Date().addingTimeInterval(-SyncHistoryStore.retention) }.prefix(30))
        try write(state, id: id)
        projectHistory(&state, id: id)
    }
    private func write(_ state: SyncState, id: UUID) throws {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var value = encoder.singleValueContainer(); try value.encode(HealthTimestamp.string(date))
        }
        let data = try encoder.encode(state)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        #if os(iOS) || os(watchOS)
        try data.write(to: file(id), options: [.atomic, .completeFileProtection])
        #else
        try data.write(to: file(id), options: .atomic)
        #endif
    }
    public func remove(_ id: UUID) throws {
        // Project durable events before removing operational state; history outlives its task.
        let state = try load(id)
        guard state.historyEvents?.isEmpty != false else { throw ConfigurationError("历史记录尚未保存，请恢复本地存储后再删除任务") }
        let url = file(id)
        if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
    }
    private func file(_ id: UUID) -> URL { directory.appendingPathComponent(id.uuidString + ".json") }

    private func projectHistory(_ state: inout SyncState, id: UUID) {
        guard let history, let events = state.historyEvents, !events.isEmpty else { return }
        do {
            try history.apply(events)
            state.historyEvents = nil
            try write(state, id: id)
            historyError = nil
        } catch { historyError = "同步历史暂未保存，事件已保留，恢复后会重试" }
    }
    func appendHistory(_ status: SyncHistoryState, pending: PendingUpload, to state: inout SyncState,
                       at date: Date, eventID: String? = nil, attemptID: String? = nil, message: String? = nil, httpStatus: Int? = nil, confirmationTimeKnown: Bool = true) {
        guard history != nil, let metadata = pending.history else { return }
        let entryID = metadata.context.journalID.uuidString + ":" + pending.batchID
        let event = SyncHistoryEvent(id: eventID ?? UUID().uuidString, entryID: entryID, context: metadata.context,
            batchID: pending.batchID, date: date, state: status, summary: metadata.summary, queuedAt: metadata.queuedAt,
            attemptID: attemptID ?? metadata.attemptID, message: message, httpStatus: httpStatus, legacy: metadata.legacy == true, confirmationTimeKnown: confirmationTimeKnown)
        state.historyEvents = (state.historyEvents ?? []) + [event]
    }
    @discardableResult public func markSending(_ identity: BatchIdentity, attemptID: String, at date: Date = Date()) throws -> Bool {
        var state = try load(identity.taskID)
        guard var pending = state.pending, identity.matches(pending) else { return false }
        pending.history?.attemptID = attemptID; pending.history?.attemptStartedAt = date
        state.pending = pending
        appendHistory(.sending, pending: pending, to: &state, at: date, eventID: attemptID + ":sending", attemptID: attemptID)
        try save(state, for: identity.taskID); return true
    }
    public func migrateHistory(task: AutomationConfig, journalID: UUID? = nil, context suppliedContext: SyncHistoryContext? = nil, now: Date = Date()) throws {
        guard history != nil else { return }
        let id = journalID ?? task.id
        var state = try load(id)
        let context = suppliedContext ?? SyncHistoryContext(task: task, journalID: id, kind: .legacy)
        if var pending = state.pending, pending.history == nil {
            pending.history = SyncHistoryMetadata(context: context, summary: SyncHistorySummary(recordCount: pending.recordCount), queuedAt: now)
            pending.history?.legacy = true; state.pending = pending
            appendHistory(.queued, pending: pending, to: &state, at: now, eventID: pending.batchID + ":legacy-queued")
        }
        for index in state.logs.indices where state.logs[index].historyRecorded != true {
            let log = state.logs[index]; state.logs[index].historyRecorded = true
            guard log.date >= now.addingTimeInterval(-SyncHistoryStore.retention), log.state != .noData, log.state != .running else { continue }
            let status: SyncHistoryState = log.state == .succeeded ? .succeeded : log.state == .failed ? .failed : .queued
            let event = SyncHistoryEvent(id: "legacy:" + log.id.uuidString, entryID: "legacy:" + id.uuidString + ":" + log.id.uuidString,
                context: context, date: log.date, state: status, summary: SyncHistorySummary(recordCount: log.records),
                message: log.message, httpStatus: log.httpStatus, legacy: true)
            state.historyEvents = (state.historyEvents ?? []) + [event]
        }
        try save(state, for: id)
    }
    /// Failures before a readable operational state get their own durable event file.
    public func recordRunFailure(context: SyncHistoryContext, message: String, at date: Date = Date()) {
        guard let history else { return }
        let event = SyncHistoryEvent(entryID: "run:" + UUID().uuidString, context: context, date: date, state: .failed, message: message)
        let url = directory.appendingPathComponent("history-errors", isDirectory: true).appendingPathComponent(event.id + ".json")
        do {
            let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .millisecondsSince1970
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            #if os(iOS) || os(watchOS)
            try encoder.encode(event).write(to: url, options: [.atomic, .completeFileProtection])
            #else
            try encoder.encode(event).write(to: url, options: .atomic)
            #endif
            try history.apply([event]); try FileManager.default.removeItem(at: url)
        } catch { historyError = "异常记录尚未写入历史，请解锁设备或检查本地存储" }
    }
    public func recoverHistory(now: Date = Date()) {
        guard let history else { return }
        do {
            if FileManager.default.fileExists(atPath: directory.path) {
                for url in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) {
                    if let id = UUID(uuidString: url.deletingPathExtension().lastPathComponent), url.pathExtension == "json" {
                        let state = try load(id); try save(state, for: id)
                    }
                }
            }
            let failures = directory.appendingPathComponent("history-errors", isDirectory: true)
            if FileManager.default.fileExists(atPath: failures.path) {
                let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .millisecondsSince1970
                for url in try FileManager.default.contentsOfDirectory(at: failures, includingPropertiesForKeys: nil) where url.pathExtension == "json" {
                    let event = try decoder.decode(SyncHistoryEvent.self, from: Data(contentsOf: url))
                    try history.apply([event], now: now); try FileManager.default.removeItem(at: url)
                }
            }
            try history.prune(now: now)
        } catch { historyError = "同步历史恢复未完成，原文件已保留" }
    }
}
public enum SyncIdentity {
    private struct QueryIdentity: Encodable { var data: DataSelection; var range: DateRange; var export: ExportSettings }
    private struct RequestIdentity: Encodable { var query: QueryIdentity; var destination: HTTPDestination; var device: ExecutionDevice? }
    public static func fingerprint(_ task: AutomationConfig) throws -> String {
        try digest(RequestIdentity(query: QueryIdentity(data: task.data, range: task.range, export: task.export), destination: task.destination, device: task.device == .watch ? .watch : nil))
    }
    public static func key(_ task: AutomationConfig, selection: MetricSelection, now: Date) throws -> (String, TypeCheckpoint) {
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = TimeZone(identifier: task.export.timeZone)!
        let today = calendar.startOfDay(for: now)
        let start: Date, end: Date?
        switch task.range.mode {
        case .incremental: start = calendar.date(byAdding: .day, value: -(task.range.bootstrapDays ?? 7), to: today)!; end = nil
        case .today: start = today; end = calendar.date(byAdding: .day, value: 1, to: today)!
        case .yesterday: start = calendar.date(byAdding: .day, value: -1, to: today)!; end = today
        case .defaultRange: start = calendar.date(byAdding: .day, value: -1, to: today)!; end = calendar.date(byAdding: .day, value: 1, to: today)!
        case .previousDays: start = calendar.date(byAdding: .day, value: -(task.range.days ?? 7), to: today)!; end = today
        case .pastDays: start = calendar.date(byAdding: .day, value: -(task.range.days ?? 7), to: today)!; end = calendar.date(byAdding: .day, value: 1, to: today)!
        case .custom: start = AutomationConfig.parseDate(task.range.start)!; end = AutomationConfig.parseDate(task.range.end)!
        }
        let query = try digest(QueryIdentity(data: task.data, range: task.range, export: task.export))
        // An incremental lower bound is frozen in the saved checkpoint, never slid on a later run.
        let window = task.range.mode == .incremental ? "incremental" : "\(start.ISO8601Format())/\(end!.ISO8601Format())"
        return (query + ":" + selection.id + ":" + window, TypeCheckpoint(start: start, end: end))
    }
    private static func digest<T: Encodable>(_ value: T) throws -> String {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        return SHA256.hash(data: try encoder.encode(value)).map { String(format: "%02x", $0) }.joined()
    }
}
