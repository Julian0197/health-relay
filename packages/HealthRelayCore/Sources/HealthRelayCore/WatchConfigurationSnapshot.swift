import Foundation

/// Same sanitized boundary as file export: no credential value or device-local reference.
public struct WatchConfigurationSnapshot: Codable, Sendable {
    public var schemaVersion = 1
    public var id = UUID()
    public var generation = Int64(Date().timeIntervalSince1970 * 1000)
    public var tasks: [AutomationConfig]
    public init(tasks: [AutomationConfig]) throws {
        self.tasks = tasks.map(Self.portable)
        try validate()
    }
    private static func portable(_ task: AutomationConfig) -> AutomationConfig {
        var copy = task
        // Legacy HTTP destinations default to Authorization when only a ref exists.
        // Preserve that requirement before removing the phone-local reference.
        if copy.destination.credentialRef != nil, copy.destination.credentialHeader == nil {
            copy.destination.credentialHeader = "Authorization"
        }
        return ConfigurationCodec.portable(copy)
    }
    public func validate(systemMajorVersion: Int = 27) throws {
        guard schemaVersion == 1, tasks.count <= 100, Set(tasks.map(\.id)).count == tasks.count else { throw ConfigurationError("Watch 配置快照无效或任务过多") }
        for task in tasks {
            guard task.device == .watch, !task.enabled else { throw ConfigurationError("只能传送关闭的 Watch 任务") }
            let issues = task.validationIssues(systemMajorVersion: systemMajorVersion, device: .watch) + task.executionCapabilityIssues
            guard issues.isEmpty else { throw ConfigurationError(issues.joined(separator: "；")) }
            guard task.destination.credentialRef == nil, task.destination.secretHeaders == nil,
                  !task.destination.headers.keys.contains(where: ConfigurationCodec.isSensitiveHeader) else { throw ConfigurationError("Watch 配置不得携带认证值或其他设备的认证引用") }
            for name in task.destination.requiredSecretHeaders ?? [] {
                guard AutomationConfig.isValidHeaderName(name), !["host", "content-type", "content-length", "idempotency-key"].contains(name.lowercased()) else { throw ConfigurationError("认证 Header 名称无效") }
            }
            let names = Array(task.destination.headers.keys) + (task.destination.requiredSecretHeaders ?? []) + [task.destination.credentialHeader].compactMap { $0 }
            guard Set(names.map { $0.lowercased() }).count == names.count else { throw ConfigurationError("认证 Header 名称重复") }
        }
        guard try JSONEncoder().encode(self).count <= 61_440 else { throw ConfigurationError("Watch 配置快照超过 60 KiB") }
    }
    public static func references(_ task: AutomationConfig) -> Set<String> {
        Set((task.destination.secretHeaders ?? [:]).values).union([task.destination.credentialRef].compactMap { $0 })
    }
    /// Existing Watch-local bindings survive only an identical portable destination.
    public func localTasks(current: [AutomationConfig]) -> [AutomationConfig] {
        tasks.map { incoming in
            var copy = incoming
            if let old = current.first(where: { $0.id == incoming.id }), Self.portable(old).destination == incoming.destination {
                copy.destination.credentialRef = old.destination.credentialRef
                copy.destination.secretHeaders = old.destination.secretHeaders
                copy.destination.requiredSecretHeaders = old.destination.requiredSecretHeaders
            }
            return copy
        }
    }
    @MainActor public static func validateReplacement(current: [AutomationConfig], incoming: [AutomationConfig], journal: SyncJournal) throws {
        for old in current {
            if let pending = try journal.load(old.id).pending {
                guard let replacement = incoming.first(where: { $0.id == old.id }),
                      try SyncIdentity.fingerprint(replacement) == pending.configurationFingerprint else {
                    throw ConfigurationError("Watch 任务「\(old.name)」有未确认批次，不能替换或移除；请先在 Watch 重试完成")
                }
            }
        }
    }
}

public struct WatchSnapshotReceipt: Codable, Equatable, Sendable {
    public var id: UUID
    public var generation: Int64
    public var accepted: Bool
    public var reason: String?
    public init(id: UUID, generation: Int64, accepted: Bool, reason: String? = nil) {
        self.id = id; self.generation = generation; self.accepted = accepted; self.reason = reason
    }
}
