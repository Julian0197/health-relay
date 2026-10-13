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
    public init() {}
}
/// One bounded outbox and its proposed checkpoint share one atomic file.
/// The committed checkpoint advances only after the batch acknowledgement.
@MainActor public final class SyncJournal {
    public let directory: URL
    public init(directory: URL) { self.directory = directory }
    public func load(_ id: UUID) throws -> SyncState {
        let url = file(id)
        guard FileManager.default.fileExists(atPath: url.path) else { return SyncState() }
        let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .iso8601
        var state = try decoder.decode(SyncState.self, from: Data(contentsOf: url))
        guard state.schemaVersion == 1 else { throw ConfigurationError("不支持的同步状态版本") }
        if state.lastConfirmedAt == nil {
            state.lastConfirmedAt = state.logs.first { $0.state == .succeeded && $0.records > 0 }?.date
        }
        return state
    }
    public func save(_ state: SyncState, for id: UUID) throws {
        let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .iso8601; encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(state)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        #if os(iOS) || os(watchOS)
        try data.write(to: file(id), options: [.atomic, .completeFileProtection])
        #else
        try data.write(to: file(id), options: .atomic)
        #endif
    }
    public func remove(_ id: UUID) throws {
        let url = file(id)
        if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
    }
    private func file(_ id: UUID) -> URL { directory.appendingPathComponent(id.uuidString + ".json") }
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
