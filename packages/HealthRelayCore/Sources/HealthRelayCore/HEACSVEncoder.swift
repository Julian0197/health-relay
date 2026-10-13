import Foundation
import CryptoKit

/// Observed manual zh-CN aggregate table, one stable file per batch.
/// The multipart `file` envelope remains provisional until a REST capture exists.
public enum HEACSVEncoder {
    public static func encode(_ batch: UploadBatch, timeZone: String, heaDataType: HEADataType? = nil, selectedTypeIdentifiers: [String]? = nil) throws -> EncodedBatch {
        if let family = heaDataType, ![.automatic, .healthMetrics].contains(family) { throw ConfigurationError("HEA CSV 仅支持健康指标") }
        let types = Set(selectedTypeIdentifiers ?? []).union(batch.records.map(\.typeIdentifier))
        for type in types { try validateType(type) }
        let columns = HEACSVProfile.columns.filter { types.contains($0.typeIdentifier) }
        let dates = try HEADates(timeZone: timeZone)
        dates.formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
        let sleepDate = DateFormatter(); sleepDate.locale = Locale(identifier: "en_US_POSIX")
        sleepDate.calendar = Calendar(identifier: .gregorian); sleepDate.timeZone = dates.formatter.timeZone
        sleepDate.dateFormat = "yyyy-MM-dd"; sleepDate.isLenient = false
        var rows: [String: [String]] = [:], seen: [String: Set<String>] = [:]
        let statistics = ["sum", "average", "minimum", "maximum"]
        for record in batch.records {
            guard record.op == .upsert else { throw ConfigurationError("HEA CSV 不支持删除事件，请使用 HealthRelay JSON 同步删除") }
            guard let payload = record.payload, payload["aggregation"] == .bool(true) else { throw ConfigurationError("HEA CSV 仅支持汇总记录，明细请使用 JSON") }
            let indices = columns.indices.filter { columns[$0].typeIdentifier == record.typeIdentifier }
            let isSleep = record.typeIdentifier == "HKCategoryTypeIdentifierSleepAnalysis"
            let isHeart = record.typeIdentifier == "HKQuantityTypeIdentifierHeartRate"
            let allowed: Set<String> = isSleep
                ? ["aggregation", "unit", "sleepDate", "totalSleep", "asleep", "inBed", "core", "deep", "rem", "awake", "sleepStart", "sleepEnd", "inBedStart", "inBedEnd"]
                : Set(["aggregation", "unit", "value"] + statistics)
            guard Set(payload.keys).isSubset(of: allowed) else { throw ConfigurationError("HEA CSV 包含无法映射的汇总字段，请使用 HealthRelay JSON") }
            guard let unit = payload["unit"]?.text else { throw ConfigurationError("HEA CSV 汇总缺少单位") }
            let date: String
            if isSleep {
                guard let text = payload["sleepDate"]?.text, let day = sleepDate.date(from: text), sleepDate.string(from: day) == text else {
                    throw ConfigurationError("HEA CSV 睡眠汇总缺少合法日期")
                }
                guard ["hr", "min", "s"].contains(unit) else { throw ConfigurationError("HEA CSV 睡眠时长单位无效") }
                _ = try HEAValue.number(payload["totalSleep"], "totalSleep")
                date = dates.formatter.string(from: day)
            } else {
                date = try dates.string(record.start)
                let outputUnit = columns[indices[0]].unit
                guard MetricCatalog.bundled.metric(record.typeIdentifier)?.units.contains(unit) == true || unit == outputUnit else {
                    throw ConfigurationError("HEA CSV 指标单位无效：\(record.typeIdentifier) / \(unit)")
                }
                let present = statistics.filter { payload[$0] != nil }
                if isHeart {
                    guard payload["sum"] == nil, !present.isEmpty else { throw ConfigurationError("HEA CSV 心率只支持最小值、最大值与平均值统计") }
                    // Native preferred value is average, then minimum, then maximum.
                    if let value = payload["value"], try HEAValue.number(value, "value") != HEAValue.number(payload[present[0]], present[0]) {
                        throw ConfigurationError("HEA CSV 心率汇总值与所选统计不一致")
                    }
                } else {
                    guard present.count <= 1 else { throw ConfigurationError("HEA CSV 单列指标只能选择一种统计，请选择单一统计或使用 HealthRelay JSON") }
                    let value = try HEAValue.number(payload["value"], "value")
                    if let statistic = present.first, try HEAValue.number(payload[statistic], statistic) != value {
                        throw ConfigurationError("HEA CSV 汇总值与所选统计不一致")
                    }
                }
            }
            guard seen[date, default: []].insert(record.typeIdentifier).inserted else {
                throw ConfigurationError("HEA CSV 同一指标和时间存在重复汇总；请使用单一来源，或使用 HealthRelay JSON 保留来源")
            }
            var row = rows[date] ?? Array(repeating: "", count: columns.count)
            for index in indices {
                let column = columns[index]
                guard let field = payload[column.field] else { continue }
                let value = try HEACSVProfile.convert(HEAValue.number(field, column.field), from: unit, to: column.unit)
                row[index] = String(decoding: try JSONEncoder().encode(value), as: UTF8.self)
            }
            rows[date] = row
        }
        let header = (["日期/时间"] + columns.map(\.header)).map(quote).joined(separator: ",")
        let csv = ([header] + rows.keys.sorted().map { ([quote($0)] + rows[$0]!).joined(separator: ",") }).joined(separator: "\n") + "\n"
        let boundary = "HEA-" + SHA256.hash(data: Data(batch.batchId.utf8)).map { String(format: "%02x", $0) }.joined()
        let body = "--\(boundary)\r\n"
            + "Content-Disposition: form-data; name=\"file\"; filename=\"HealthAutoExport.csv\"\r\n"
            + "Content-Type: text/csv; charset=utf-8\r\n\r\n"
            + csv + "\r\n--\(boundary)--\r\n"
        return EncodedBatch(body: Data(body.utf8), contentType: "multipart/form-data; boundary=\(boundary)")
    }

    static func validateType(_ type: String) throws {
        guard HEACSVProfile.supportedTypes.contains(type) else {
            throw ConfigurationError("HEA CSV 尚无此指标的可靠汇总列映射，请使用 HealthRelay JSON：\(type)")
        }
    }
    static func quote(_ text: String) -> String {
        let first = text.trimmingCharacters(in: .whitespacesAndNewlines).first
        let formula = first.map { "=+-@".contains($0) } ?? false
        let controlPrefix = text.unicodeScalars.first.map { CharacterSet(charactersIn: "\t\r\n").contains($0) } ?? false
        let safe = (formula || controlPrefix ? "'" : "") + text
        return safe.rangeOfCharacter(from: CharacterSet(charactersIn: ",\"\r\n")) != nil ? "\"" + safe.replacingOccurrences(of: "\"", with: "\"\"") + "\"" : safe
    }
}
