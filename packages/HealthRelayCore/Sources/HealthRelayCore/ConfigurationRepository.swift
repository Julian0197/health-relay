import Foundation

public struct ConfigurationRepository: Sendable {
    public let fileURL: URL
    public init(fileURL: URL) { self.fileURL = fileURL }
    private struct Envelope: Codable { var schemaVersion = 1; var tasks: [AutomationConfig]; var watchReceipt: WatchSnapshotReceipt? }
    public func load() throws -> [AutomationConfig] {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return [] }
        let envelope = try JSONDecoder().decode(Envelope.self, from: Data(contentsOf: fileURL))
        guard envelope.schemaVersion == 1 else { throw ConfigurationError("本地任务文件的版本不受支持") }
        guard Set(envelope.tasks.map(\.id)).count == envelope.tasks.count else { throw ConfigurationError("本地任务 ID 重复") }
        return envelope.tasks
    }
    public func loadWatchReceipt() throws -> WatchSnapshotReceipt? {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return nil }
        return try JSONDecoder().decode(Envelope.self, from: Data(contentsOf: fileURL)).watchReceipt
    }
    public func save(_ configs: [AutomationConfig], watchReceipt: WatchSnapshotReceipt? = nil) throws {
        guard Set(configs.map(\.id)).count == configs.count else { throw ConfigurationError("任务 ID 重复，未修改原文件") }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(Envelope(tasks: configs, watchReceipt: watchReceipt))
        try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        #if os(iOS) || os(watchOS)
        try data.write(to: fileURL, options: [.atomic, .completeFileProtection])
        #else
        try data.write(to: fileURL, options: .atomic)
        #endif
    }
}
