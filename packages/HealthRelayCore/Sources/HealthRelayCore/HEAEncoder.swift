import Foundation

/// HEA v2 compatibility for explicitly mapped quantities and raw/aggregated sleep.
/// Native HealthRelay JSON retains available UUIDs, metadata and deletion events.
/// Public shapes: https://help.healthyapps.dev/en/health-auto-export/export-format/health-metrics/
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
        "HKQuantityTypeIdentifierBodyMass": "weight_&_body_mass",
        "HKQuantityTypeIdentifierBodyMassIndex": "body_mass_index",
        "HKQuantityTypeIdentifierBodyTemperature": "body_temperature",
        "HKQuantityTypeIdentifierHeight": "height",
        "HKQuantityTypeIdentifierDietaryWater": "dietary_water",
        "HKQuantityTypeIdentifierOxygenSaturation": "blood_oxygen_saturation",
        "HKQuantityTypeIdentifierRespiratoryRate": "respiratory_rate",
        "HKQuantityTypeIdentifierHeartRateRecoveryOneMinute": "heart_rate_recovery",
        "HKQuantityTypeIdentifierVO2Max": "vo2_max",
        "HKCategoryTypeIdentifierSleepAnalysis": "sleep_analysis"
    ]
    public static func encode(_ batch: UploadBatch, timeZone: String) throws -> EncodedBatch {
        guard let zone = TimeZone(identifier: timeZone) else { throw ConfigurationError("HEA 导出时区无效") }
        let dateFormatter = DateFormatter()
        dateFormatter.locale = Locale(identifier: "en_US_POSIX")
        dateFormatter.calendar = Calendar(identifier: .gregorian)
        dateFormatter.timeZone = zone
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
                guard let payload = record.payload else { throw ConfigurationError("HEA 明细缺少数据") }
                var point: [String: JSONValue] = ["source": .string(record.source?.name ?? "unknown")]
                let aggregated = payload["aggregation"] == .bool(true)
                if type == "HKCategoryTypeIdentifierSleepAnalysis" {
                    unit = "hr"
                    if aggregated {
                        guard case .string(let sleepDate) = payload["sleepDate"],
                              case .number = payload["totalSleep"] else { throw ConfigurationError("HEA 睡眠汇总缺少日期或总时长") }
                        point["date"] = .string(sleepDate)
                        for key in ["totalSleep", "asleep", "core", "deep", "rem", "awake", "inBed"] {
                            if case .number = payload[key] { point[key] = payload[key] }
                        }
                        for key in ["sleepStart", "sleepEnd", "inBedStart", "inBedEnd"] {
                            if case .string(let value) = payload[key] { point[key] = .string(try date(value)) }
                        }
                    } else {
                        let stages = ["In Bed", "Asleep", "Awake", "Core", "Deep", "REM"]
                        guard case .number(let value) = payload["value"], value.isFinite,
                              value.rounded() == value, (0..<Double(stages.count)).contains(value),
                              let start = AutomationConfig.parseDate(record.start), let end = AutomationConfig.parseDate(record.end), end >= start else {
                            throw ConfigurationError("未知睡眠阶段或无效时间范围")
                        }
                        point["startDate"] = .string(try date(record.start)); point["endDate"] = .string(try date(record.end))
                        point["value"] = .string(stages[Int(value)]); point["qty"] = .number(end.timeIntervalSince(start) / 3600)
                    }
                } else {
                    guard case .string(let code) = payload["unit"] else { throw ConfigurationError("HEA 数量明细缺少单位") }
                    guard case .number(let value) = payload["value"] else { throw ConfigurationError("HEA 明细缺少数量值") }
                    let exportedUnit = code == "count/min" && type.contains("HeartRate") ? "bpm" : code
                    guard unit == nil || unit == exportedUnit else { throw ConfigurationError("同一指标不能混用输出单位") }
                    unit = exportedUnit
                    point["date"] = .string(try date(record.start))
                    if type == "HKQuantityTypeIdentifierHeartRate" {
                        if aggregated {
                            for (native, hea) in [("minimum", "Min"), ("average", "Avg"), ("maximum", "Max")] {
                                if case .number = payload[native] { point[hea] = payload[native] }
                            }
                            guard point["Min"] != nil || point["Avg"] != nil || point["Max"] != nil else {
                                throw ConfigurationError("HEA 心率汇总缺少统计值")
                            }
                        } else {
                            point["Min"] = .number(value); point["Avg"] = .number(value); point["Max"] = .number(value)
                        }
                    } else {
                        // HealthKit percent() stores fractions. This compatibility profile
                        // exports display percentages; the HEA numeric scale still needs capture verification.
                        point["qty"] = .number(code == "%" ? value * 100 : value)
                    }
                }
                points.append(.object(point))
            }
            metrics.append(.object(["name": .string(name), "units": .string(unit ?? ""), "data": .array(points)]))
        }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return EncodedBatch(body: try encoder.encode(JSONValue.object(["data": .object(["metrics": .array(metrics)])])), contentType: "application/json")
    }
}
