import Foundation

public enum HEARequestMetadata {
    public static func headers(task: AutomationConfig, batchID: String) -> [String: String] {
        let period: String
        switch task.range.mode.rawValue {
        case "incremental": period = "lastsync"
        case "today": period = "today"
        case "yesterday": period = "yesterday"
        case "defaultRange": period = "none"
        case "previousDays" where task.range.days == 7: period = "previous7days"
        // HEA does not document exact equivalents for rolling/custom ranges or arbitrary N.
        // "custom" is a HealthRelay compatibility extension, not a claimed HEA enum value.
        default: period = "custom"
        }
        return [
            "automation-name": headerValue(task.name),
            "automation-id": task.id.uuidString.lowercased(),
            "automation-aggregation": task.export.grouping.rawValue,
            "automation-period": period,
            "session-id": headerValue(batchID)
        ]
    }

    private static func headerValue(_ value: String) -> String {
        value.utf8.map { byte in
            if (32...126).contains(byte), byte != 37 { return String(UnicodeScalar(byte)) }
            return String(format: "%%%02X", byte)
        }.joined()
    }
}
