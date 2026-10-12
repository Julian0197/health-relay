import Foundation

public struct ConfigurationRepository: Sendable {
    public let fileURL: URL
    public init(fileURL: URL) { self.fileURL = fileURL }
    private struct Envelope: Codable { var schemaVersion = 1; var tasks: [AutomationConfig] }
    public func load() throws -> [AutomationConfig] {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return [] }
        let envelope = try JSONDecoder().decode(Envelope.self, from: Data(contentsOf: fileURL))
        guard envelope.schemaVersion == 1 else { throw ConfigurationError("本地任务文件的版本不受支持") }
        guard Set(envelope.tasks.map(\.id)).count == envelope.tasks.count else { throw ConfigurationError("本地任务 ID 重复") }
        return envelope.tasks
    }
    public func save(_ configs: [AutomationConfig]) throws {
        guard Set(configs.map(\.id)).count == configs.count else { throw ConfigurationError("任务 ID 重复，未修改原文件") }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(Envelope(tasks: configs))
        try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        #if os(iOS)
        try data.write(to: fileURL, options: [.atomic, .completeFileProtection])
        #else
        try data.write(to: fileURL, options: .atomic)
        #endif
    }
}
