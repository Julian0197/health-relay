import Foundation

public enum JSONValue: Codable, Equatable, Sendable {
    case string(String), number(Double), bool(Bool), array([JSONValue]), object([String: JSONValue]), null
    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let v = try? value.decode(Bool.self) { self = .bool(v) }
        else if let v = try? value.decode(Double.self) { self = .number(v) }
        else if let v = try? value.decode(String.self) { self = .string(v) }
        else if let v = try? value.decode([JSONValue].self) { self = .array(v) }
        else { self = .object(try value.decode([String: JSONValue].self)) }
    }
    public func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case .string(let v): try value.encode(v)
        case .number(let v): try value.encode(v)
        case .bool(let v): try value.encode(v)
        case .array(let v): try value.encode(v)
        case .object(let v): try value.encode(v)
        case .null: try value.encodeNil()
        }
    }
}
public struct RecordSource: Codable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var version: String?
    public var device: String?
    public init(id: String, name: String, version: String? = nil, device: String? = nil) {
        self.id = id; self.name = name; self.version = version; self.device = device
    }
}
public struct HealthRecord: Codable, Equatable, Sendable {
    public enum Operation: String, Codable, Sendable { case upsert, delete }
    public var op: Operation
    public var typeIdentifier: String
    public var recordId: String
    public var start: String?
    public var end: String?
    public var source: RecordSource?
    public var payload: [String: JSONValue]?
    public init(op: Operation, typeIdentifier: String, recordId: String, start: String? = nil, end: String? = nil, source: RecordSource? = nil, payload: [String: JSONValue]? = nil) {
        self.op = op; self.typeIdentifier = typeIdentifier; self.recordId = recordId
        self.start = start; self.end = end; self.source = source; self.payload = payload
    }
}
public struct UploadBatch: Codable, Sendable {
    public var schemaVersion = 1
    public var batchId = UUID().uuidString.lowercased()
    public var taskId: UUID
    public var configRevision: Int
    public var createdAt = Date().ISO8601Format()
    public var records: [HealthRecord]
    public init(task: AutomationConfig, records: [HealthRecord]) {
        taskId = task.id; configRevision = task.revision; self.records = records
    }
}
public struct EncodedBatch: Sendable {
    public let body: Data
    public let contentType: String
}
public enum BatchEncoder {
    public static func encode(_ batch: UploadBatch, format: String = "healthrelay.v1", timeZone: String = "UTC", heaDataType: HEADataType? = nil) throws -> EncodedBatch {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        if format == "hea.csv" { return try HEACSVEncoder.encode(batch, timeZone: timeZone, heaDataType: heaDataType) }
        if ["hea.v1", "hea.v2"].contains(format) { return try HEAEncoder.encode(batch, timeZone: timeZone, version: format == "hea.v1" ? 1 : 2, heaDataType: heaDataType) }
        if format == "healthrelay.v1" {
            return EncodedBatch(body: try encoder.encode(batch), contentType: "application/json")
        }
        guard ["csv", "markdown"].contains(format) else { throw ConfigurationError("该格式尚未接入执行，请选择 HealthRelay JSON、CSV 或 Markdown") }
        let headings = ["op", "typeIdentifier", "recordId", "start", "end", "sourceId", "payload"]
        let rows = try batch.records.map { record -> [String] in
            let payload = try record.payload.map { String(decoding: try encoder.encode($0), as: UTF8.self) } ?? ""
            return [record.op.rawValue, record.typeIdentifier, record.recordId, record.start ?? "", record.end ?? "", record.source?.id ?? "", payload]
        }
        if format == "csv" {
            let text = ([headings] + rows).map { $0.map { "\"" + $0.replacingOccurrences(of: "\"", with: "\"\"") + "\"" }.joined(separator: ",") }.joined(separator: "\r\n") + "\r\n"
            return EncodedBatch(body: Data(text.utf8), contentType: "text/csv; charset=utf-8")
        }
        let line: ([String]) -> String = { "| " + $0.map { $0.replacingOccurrences(of: "|", with: "&#124;").replacingOccurrences(of: "\n", with: "<br>").replacingOccurrences(of: "\r", with: "") }.joined(separator: " | ") + " |" }
        let text = ([line(headings), line(headings.map { _ in "---" })] + rows.map(line)).joined(separator: "\n") + "\n"
        return EncodedBatch(body: Data(text.utf8), contentType: "text/markdown; charset=utf-8")
    }
}
public extension AutomationConfig {
    var executionCapabilityIssues: [String] {
        var issues: [String] = []
        if !["healthrelay.v1", "hea.v1", "hea.v2", "hea.csv", "csv", "markdown"].contains(export.format) { issues.append("未知导出格式") }
        if export.format.hasPrefix("hea.") {
            if export.heaDataType == .medications { issues.append("HEA 用药需真实 HEA 抓包确认疗程与剂量单位，请使用 HealthRelay JSON") }
            for selection in data.selections {
                do {
                    let family = try HEAEncoder.family(for: selection.id, selection: export.heaDataType)
                    if export.format == "hea.csv", family != .healthMetrics { issues.append("HEA CSV 仅支持健康指标，其他数据类型需要真实 HEA 抓包") }
                } catch { issues.append((error as? ConfigurationError)?.message ?? error.localizedDescription) }
            }
            if export.format == "hea.csv" {
                if let family = export.heaDataType, ![.automatic, .healthMetrics].contains(family) { issues.append("HEA CSV 仅支持健康指标") }
                if export.mode != .aggregate { issues.append("HEA CSV REST 导出必须使用汇总模式") }
                for selection in data.selections where selection.id != "HKCategoryTypeIdentifierSleepAnalysis" {
                    guard let metric = MetricCatalog.bundled.metric(selection.id), metric.family == .quantity, !metric.statistics.isEmpty else {
                        issues.append("HEA CSV 仅支持可汇总数量指标与睡眠"); continue
                    }
                }
            }
        }
        return issues
    }
    var executionIssues: [String] {
        var issues = executionCapabilityIssues
        if destination.requiredSecretHeaders?.isEmpty == false { issues.append("请重新填写导入配置的认证值") }
        if destination.credentialHeader != nil && destination.credentialRef == nil { issues.append("请填写认证值") }
        return issues
    }
}

public enum HealthTimestamp {
    public static func string(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter.string(from: date)
    }
}
