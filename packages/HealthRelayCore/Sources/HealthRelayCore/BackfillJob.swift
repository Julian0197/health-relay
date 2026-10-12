import Foundation

public struct BackfillJob: Codable, Identifiable, Sendable {
    public var id = UUID()
    public var createdAt = Date()
    public var task: AutomationConfig
    public var completedAt: Date?
    public init(task: AutomationConfig, start: Date, end: Date) throws {
        guard start < end, end <= Date() else { throw ConfigurationError("补传范围必须有效，结束时间不能晚于现在") }
        self.task = task
        self.task.range = DateRange(mode: .custom, bootstrapDays: nil, start: HealthTimestamp.string(start), end: HealthTimestamp.string(end))
        self.task.enabled = false
    }
}
@MainActor public final class BackfillRepository {
    private let file: URL
    public init(file: URL) { self.file = file }
    public func load() throws -> [BackfillJob] {
        guard FileManager.default.fileExists(atPath: file.path) else { return [] }
        let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode([BackfillJob].self, from: Data(contentsOf: file))
    }
    public func save(_ jobs: [BackfillJob]) throws {
        let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .iso8601
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        #if os(iOS)
        try encoder.encode(jobs).write(to: file, options: [.atomic, .completeFileProtection])
        #else
        try encoder.encode(jobs).write(to: file, options: .atomic)
        #endif
    }
}
