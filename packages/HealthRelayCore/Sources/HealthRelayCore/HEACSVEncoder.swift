import Foundation
import CryptoKit

/// Multipart CSV compatibility profile, one `file` part per metric.
/// HEA documents multipart/form-data, but its exact field names and CSV layout
/// are not a published contract. These choices require real HEA capture verification.
public enum HEACSVEncoder {
    public static func encode(_ batch: UploadBatch, timeZone: String) throws -> EncodedBatch {
        let encoded = try HEAEncoder.encode(batch, timeZone: timeZone)
        let document = try JSONDecoder().decode(Document.self, from: encoded.body)
        let boundary = "HEA-" + SHA256.hash(data: Data(batch.batchId.utf8)).map { String(format: "%02x", $0) }.joined()
        var body = ""
        for metric in document.data.metrics {
            body += "--\(boundary)\r\n"
            body += "Content-Disposition: form-data; name=\"file\"; filename=\"\(metric.name).csv\"\r\n"
            body += "Content-Type: text/csv; charset=utf-8\r\n\r\n"
            body += try csv(metric)
            body += "\r\n"
        }
        body += "--\(boundary)--\r\n"
        return EncodedBatch(body: Data(body.utf8), contentType: "multipart/form-data; boundary=\(boundary)")
    }

    private struct Document: Decodable {
        var data: Payload
        struct Payload: Decodable { var metrics: [Metric] }
    }
    private struct Metric: Decodable {
        var name: String
        var units: String
        var data: [[String: JSONValue]]
    }

    private static func csv(_ metric: Metric) throws -> String {
        let preferredOrder = ["date", "startDate", "endDate", "qty", "value", "Min", "Avg", "Max",
                              "totalSleep", "asleep", "core", "deep", "rem", "awake", "inBed",
                              "sleepStart", "sleepEnd", "inBedStart", "inBedEnd", "systolic", "diastolic", "source"]
        let keys = Set(metric.data.flatMap { $0.keys })
        let columns = preferredOrder.filter { keys.contains($0) } + keys.subtracting(preferredOrder).sorted()
        let headers = columns.map { quote(heading($0, metric: metric)) }.joined(separator: ",")
        let rows = try metric.data.map { point in
            try columns.map { try cell(point[$0]) }.joined(separator: ",")
        }
        return ([headers] + rows).joined(separator: "\r\n") + "\r\n"
    }

    private static func heading(_ key: String, metric: Metric) -> String {
        let title = metric.name.replacingOccurrences(of: "_", with: " ").capitalized(with: Locale(identifier: "en_US_POSIX"))
        let unit = " (\(metric.units))"
        switch key {
        case "qty": return (metric.name == "sleep_analysis" ? "Duration" : title) + unit
        case "Min", "Avg", "Max": return title + " " + key + unit
        case "totalSleep": return "Total Sleep" + unit
        case "asleep", "core", "deep", "rem", "awake", "inBed":
            return (key == "inBed" ? "In Bed" : key == "rem" ? "REM" : key.capitalized) + unit
        case "startDate": return "Start Date"
        case "endDate": return "End Date"
        case "sleepStart": return "Sleep Start"
        case "sleepEnd": return "Sleep End"
        case "inBedStart": return "In Bed Start"
        case "inBedEnd": return "In Bed End"
        case "value": return metric.name == "sleep_analysis" ? "Stage" : "Value"
        case "systolic", "diastolic": return key.capitalized + unit
        default: return key.capitalized
        }
    }

    private static func cell(_ value: JSONValue?) throws -> String {
        switch value {
        case .string(let text): return quote(text)
        case .number, .bool:
            return "\"" + String(decoding: try JSONEncoder().encode(value), as: UTF8.self) + "\""
        case nil, .null: return "\"\""
        default: throw ConfigurationError("HEA CSV 不支持嵌套单元格")
        }
    }

    private static func quote(_ text: String) -> String {
        let first = text.trimmingCharacters(in: .whitespacesAndNewlines).first
        let formula = first.map { "=+-@".contains($0) } ?? false
        let controlPrefix = text.first.map { "\t\r\n".contains($0) } ?? false
        let safe = (formula || controlPrefix ? "'" : "") + text
        return "\"" + safe.replacingOccurrences(of: "\"", with: "\"\"") + "\""
    }
}
