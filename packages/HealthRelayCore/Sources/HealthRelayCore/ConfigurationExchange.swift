import Foundation

public struct ConfigurationIssue: Codable, Equatable, Sendable {
    public enum Severity: String, Codable, Sendable { case error, warning }
    public let severity: Severity
    public let code: String
    /// JSON Pointer; an empty string identifies the document root.
    public let path: String
    public let message: String
}

public struct ConfigurationInspection: Codable, Sendable {
    /// Portable validity does not imply permission or readiness to execute.
    public let valid: Bool
    public let tasks: [AutomationConfig]
    public let issues: [ConfigurationIssue]
    fileprivate init(tasks: [AutomationConfig] = [], issues: [ConfigurationIssue]) {
        self.valid = !issues.contains { $0.severity == .error }
        self.tasks = tasks.map(ConfigurationCodec.portable)
        self.issues = issues
    }
}

public enum ConfigurationExchange {
    public static let maximumInputBytes = 1_048_576
    private struct Bundle: Codable {
        var kind = "healthrelay.automations"
        var schemaVersion = 1
        var tasks: [AutomationConfig]
    }

    public static func inspect(_ data: Data, systemMajorVersion: Int = 27) -> ConfigurationInspection {
        guard data.count <= maximumInputBytes else {
            return failure("input_too_large", "", "配置文件超过 1 MiB。")
        }
        guard let text = String(data: data, encoding: .utf8) else {
            return failure("invalid_json", "", "请输入 UTF-8 JSON。")
        }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        var json = trimmed
        if trimmed.hasPrefix("```json\n"), trimmed.hasSuffix("\n```") {
            json = String(trimmed.dropFirst("```json\n".count).dropLast("\n```".count))
        } else if trimmed.hasPrefix("```json\r\n"), trimmed.hasSuffix("\r\n```") {
            json = String(trimmed.dropFirst("```json\r\n".count).dropLast("\r\n```".count))
        }
        guard let root = try? JSONSerialization.jsonObject(with: Data(json.utf8)),
              let object = root as? [String: Any] else {
            return failure("invalid_json", "", "请输入一个完整 JSON 对象，或一个完整的 json Markdown 代码块。")
        }
        let isBundle = object["kind"] != nil || object["tasks"] != nil
        let schemaObject: [String: Any]
        do { schemaObject = try JSONSerialization.jsonObject(with: schema()) as! [String: Any] }
        catch { return failure("schema_unavailable", "", "内置配置协议不可用。") }
        let definitions = schemaObject["$defs"] as! [String: Any]
        let shape = definitions[isBundle ? "bundle" : "automation"] as! [String: Any]
        let unknown = unknownFields(object, schema: shape, definitions: definitions, path: "")
        if !unknown.isEmpty { return ConfigurationInspection(issues: unknown) }
        if isBundle, object["kind"] as? String != "healthrelay.automations" {
            return failure("invalid_kind", "/kind", "配置包 kind 必须为 healthrelay.automations。")
        }
        let rawTasks: [AutomationConfig]
        do {
            if isBundle {
                let bundle = try JSONDecoder().decode(Bundle.self, from: Data(json.utf8))
                guard bundle.schemaVersion == 1 else { return failure("unsupported_version", "/schemaVersion", "仅支持 schemaVersion 1。") }
                rawTasks = bundle.tasks
            } else { rawTasks = [try JSONDecoder().decode(AutomationConfig.self, from: Data(json.utf8))] }
        } catch let error as DecodingError { return ConfigurationInspection(issues: [decodingIssue(error)]) }
        catch { return failure("invalid_json", "", "无法读取配置 JSON。") }
        guard (1...100).contains(rawTasks.count) else { return failure("task_count", isBundle ? "/tasks" : "", "配置包必须包含 1–100 个任务。") }
        var issues: [ConfigurationIssue] = []
        var ids: Set<UUID> = []
        for (index, task) in rawTasks.enumerated() {
            let path = isBundle ? "/tasks/\(index)" : ""
            if !ids.insert(task.id).inserted {
                issues.append(issue("duplicate_id", path + "/id", "同一配置包中的任务 ID 不能重复。"))
            }
            if task.schemaVersion != 1 {
                issues.append(issue("unsupported_version", path + "/schemaVersion", "仅支持 schemaVersion 1。"))
            } else {
                let messages = task.validationIssues(systemMajorVersion: systemMajorVersion, device: task.device)
                    + task.executionCapabilityIssues
                issues += messages.map { issue("invalid_configuration", path, safeMessage($0)) }
            }
            let portable = ConfigurationCodec.portable(task)
            if portable.destination.credentialHeader != nil || portable.destination.requiredSecretHeaders?.isEmpty == false {
                issues.append(ConfigurationIssue(severity: .warning, code: "authentication_required", path: path + "/destination", message: "认证值不会随配置传输；请在执行设备上重新绑定。配置有效不代表已获授权或可以执行。"))
            }
        }
        let watchTasks = rawTasks.filter { $0.device == .watch }
        if !watchTasks.isEmpty {
            do {
                let snapshot = try WatchConfigurationSnapshot(tasks: watchTasks)
                try snapshot.validate(systemMajorVersion: systemMajorVersion)
            } catch {
                issues.append(issue("watch_snapshot", isBundle ? "/tasks" : "", "Watch 配置必须满足指标与系统能力、认证 Header 唯一性和合法性，以及合计 60 KiB 的快照限制。"))
            }
        }
        return ConfigurationInspection(tasks: rawTasks, issues: issues)
    }

    public static func export(_ tasks: [AutomationConfig]) throws -> Data {
        guard (1...100).contains(tasks.count) else { throw ConfigurationError("配置包必须包含 1–100 个任务。") }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        let data = try encoder.encode(Bundle(tasks: tasks.map(ConfigurationCodec.portable)))
        guard data.count <= maximumInputBytes else { throw ConfigurationError("导出配置超过 1 MiB，请减少任务数量或配置内容。") }
        return data
    }

    public static func template(device: ExecutionDevice = .iPhone) -> AutomationConfig {
        var task = AutomationConfig()
        task.device = device
        task.name = device == .watch ? "心率同步 · Watch" : "心率同步"
        task.data.selections = [MetricSelection(typeIdentifier: "HKQuantityTypeIdentifierHeartRate", unit: "count/min")]
        task.destination.url = "https://example.com/health"
        task.destination.credentialHeader = "Authorization"
        task.destination.credentialPrefix = "Bearer "
        task.execution.periodicPolling = true
        return ConfigurationCodec.portable(task)
    }

    public static func schema() throws -> Data {
        guard let url = Foundation.Bundle.module.url(forResource: "automation.schema", withExtension: "json") else {
            throw ConfigurationError("内置配置协议不可用。")
        }
        return try Data(contentsOf: url)
    }

    /// Synthetic, portable authoring context; never reads saved tasks or credentials.
    public static func reference() throws -> Data {
        let encoder = JSONEncoder()
        let object: [String: Any] = [
            "schema": try JSONSerialization.jsonObject(with: schema()),
            "catalog": try JSONSerialization.jsonObject(with: encoder.encode(MetricCatalog.bundled)),
            "examples": try JSONSerialization.jsonObject(with: encoder.encode([template(), template(device: .watch)])),
            "constraints": [
                "Output one JSON task or a healthrelay.automations bundle with 1–100 tasks. Use only catalog identifiers and supported units.",
                "Use placeholders for endpoints and authentication. Imported tasks are disabled; bind credentials and review permissions on each execution device.",
                "minimumIntervalSeconds is a minimum interval, not an exact schedule. iOS and watchOS control background opportunities.",
                "Watch capabilities differ from iPhone. Validate against the target OS; Watch transfer is limited to a combined 60 KiB snapshot.",
                "Valid portable configuration does not mean authorized or ready to run."
            ]
        ]
        return try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
    }

    public static func copiesForImport(_ inspection: ConfigurationInspection) throws -> [AutomationConfig] {
        guard inspection.valid, inspect(try export(inspection.tasks)).valid else { throw ConfigurationError("配置包含错误，不能导入。") }
        return inspection.tasks.map { task in
            var copy = ConfigurationCodec.portable(task)
            copy.id = UUID(); copy.revision = 1
            return copy
        }
    }

    public static func watchCopy(_ task: AutomationConfig) throws -> AutomationConfig {
        var copy = ConfigurationCodec.portable(task)
        copy.id = UUID(); copy.revision = 1; copy.device = .watch
        if !copy.name.hasSuffix(" · Watch") { copy.name += " · Watch" }
        let report = inspect(try export([copy]))
        guard report.valid else { throw ConfigurationError(report.issues.filter { $0.severity == .error }.map(\.message).joined(separator: "；")) }
        return copy
    }

    private static func issue(_ code: String, _ path: String, _ message: String) -> ConfigurationIssue {
        ConfigurationIssue(severity: .error, code: code, path: path, message: message)
    }
    private static func failure(_ code: String, _ path: String, _ message: String) -> ConfigurationInspection {
        ConfigurationInspection(issues: [issue(code, path, message)])
    }
    private static func safeMessage(_ message: String) -> String {
        // Existing validators append untrusted identifiers after this separator.
        String(message.split(separator: "：", maxSplits: 1).first ?? "配置不符合执行要求")
    }
    private static func pointer(_ parts: [String]) -> String {
        parts.map { "/" + $0.replacingOccurrences(of: "~", with: "~0").replacingOccurrences(of: "/", with: "~1") }.joined()
    }
    private static func decodingIssue(_ error: DecodingError) -> ConfigurationIssue {
        let context: DecodingError.Context
        let code: String
        let message: String
        var missingKey: String?
        switch error {
        case .keyNotFound(let key, let value):
            context = value; missingKey = key.stringValue; code = "missing_field"; message = "缺少必填字段。"
        case .typeMismatch(_, let value), .valueNotFound(_, let value):
            context = value; code = "invalid_type"; message = "字段类型不符合配置协议。"
        case .dataCorrupted(let value):
            context = value; code = "invalid_value"; message = "字段值不符合配置协议，请检查枚举或标识符格式。"
        @unknown default: return issue("invalid_value", "", "字段值不符合配置协议。")
        }
        var parts = context.codingPath.map { $0.intValue.map(String.init) ?? $0.stringValue }
        if let missingKey { parts.append(missingKey) }
        return issue(code, pointer(parts), message)
    }
    /// Traverse only schema properties to reject ignored JSON keys. Decoding and model validators own values.
    private static func unknownFields(_ value: Any, schema: [String: Any], definitions: [String: Any], path: String) -> [ConfigurationIssue] {
        if let reference = schema["$ref"] as? String, let name = reference.split(separator: "/").last,
           let target = definitions[String(name)] as? [String: Any] {
            return unknownFields(value, schema: target, definitions: definitions, path: path)
        }
        if let object = value as? [String: Any], let properties = schema["properties"] as? [String: Any] {
            return object.keys.sorted().flatMap { key -> [ConfigurationIssue] in
                let childPath = path + pointer([key])
                guard let child = properties[key] as? [String: Any] else {
                    return [issue("unknown_field", childPath, "未知字段；请按配置协议修正。")]
                }
                return unknownFields(object[key]!, schema: child, definitions: definitions, path: childPath)
            }
        }
        if let array = value as? [Any], let item = schema["items"] as? [String: Any] {
            return array.enumerated().flatMap { unknownFields($0.element, schema: item, definitions: definitions, path: path + "/\($0.offset)") }
        }
        return []
    }
}
