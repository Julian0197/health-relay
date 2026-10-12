import Foundation

/// Compatibility profile for explicitly mapped raw quantity metrics and sleep segments.
/// Native HealthRelay JSON remains the lossless export (UUIDs, metadata, deletions).
public enum HEAEncoder {
    public static let metricNames: [String: String] = [
        "HKQuantityTypeIdentifierHeartRateVariabilitySDNN": "heart_rate_variability",
        "HKQuantityTypeIdentifierHeartRateVariabilityRMSSD": "heart_rate_variability_rmssd",
        "HKQuantityTypeIdentifierHeartRate": "heart_rate",
        "HKQuantityTypeIdentifierRestingHeartRate": "resting_heart_rate",
        "HKQuantityTypeIdentifierWalkingHeartRateAverage": "walking_heart_rate",
        "HKQuantityTypeIdentifierStepCount": "step_count",
        "HKQuantityTypeIdentifierActiveEnergyBurned": "active_energy",
        "HKQuantityTypeIdentifierBasalEnergyBurned": "basal_energy_burned",
        "HKQuantityTypeIdentifierDistanceWalkingRunning": "walking_running_distance",
        "HKQuantityTypeIdentifierAppleExerciseTime": "apple_exercise_time",
        "HKQuantityTypeIdentifierBodyMass": "weight_body_mass",
        "HKQuantityTypeIdentifierOxygenSaturation": "blood_oxygen_saturation",
        "HKQuantityTypeIdentifierRespiratoryRate": "respiratory_rate",
        "HKQuantityTypeIdentifierHeartRateRecoveryOneMinute": "heart_rate_recovery",
        "HKQuantityTypeIdentifierVO2Max": "vo2_max",
        "HKCategoryTypeIdentifierSleepAnalysis": "sleep_analysis"
    ]
    public static func encode(_ batch: UploadBatch, timeZone: String) throws -> EncodedBatch {
        let dateFormatter = DateFormatter()
        dateFormatter.locale = Locale(identifier: "en_US_POSIX")
        dateFormatter.calendar = Calendar(identifier: .gregorian)
        dateFormatter.timeZone = TimeZone(identifier: timeZone)
        dateFormatter.dateFormat = "yyyy-MM-dd HH:mm:ss Z"
        func date(_ text: String?) throws -> String {
            guard let value = AutomationConfig.parseDate(text) else { throw ConfigurationError("HEA 明细缺少合法时间") }
            return dateFormatter.string(from: value)
        }
        var metrics: [JSONValue] = []
        for type in Set(batch.records.map(\.typeIdentifier)).sorted() {
            guard let name = metricNames[type] else { throw ConfigurationError("该指标的 HEA 格式尚未验证，请使用 HealthRelay JSON") }
            let records = batch.records.filter { $0.typeIdentifier == type }
            var points: [JSONValue] = [], unit: String?
            for record in records {
                guard record.op == .upsert else { throw ConfigurationError("HEA 格式不支持删除事件，请使用 HealthRelay JSON 同步删除") }
                guard let payload = record.payload, case .number(let value) = payload["value"] else { throw ConfigurationError("HEA 明细缺少数量或分类值") }
                var point: [String: JSONValue] = ["source": .string(record.source?.name ?? "unknown")]
                if type == "HKCategoryTypeIdentifierSleepAnalysis" {
                    let stages = [0: "In Bed", 1: "Asleep", 2: "Awake", 3: "Core", 4: "Deep", 5: "REM"]
                    guard let stage = stages[Int(value)], let start = AutomationConfig.parseDate(record.start), let end = AutomationConfig.parseDate(record.end) else { throw ConfigurationError("未知睡眠阶段") }
                    unit = "hr"
                    point["startDate"] = .string(try date(record.start)); point["endDate"] = .string(try date(record.end))
                    point["value"] = .string(stage); point["qty"] = .number(end.timeIntervalSince(start) / 3600)
                } else {
                    guard case .string(let code) = payload["unit"] else { throw ConfigurationError("HEA 数量明细缺少单位") }
                    let exportedUnit = code == "count/min" && type.contains("HeartRate") ? "bpm" : code
                    guard unit == nil || unit == exportedUnit else { throw ConfigurationError("同一指标不能混用输出单位") }
                    unit = exportedUnit
                    point["date"] = .string(try date(record.start)); point["qty"] = .number(value)
                }
                points.append(.object(point))
            }
            metrics.append(.object(["name": .string(name), "units": .string(unit ?? ""), "data": .array(points)]))
        }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return EncodedBatch(body: try encoder.encode(JSONValue.object(["data": .object(["metrics": .array(metrics)])])), contentType: "application/json")
    }
}
