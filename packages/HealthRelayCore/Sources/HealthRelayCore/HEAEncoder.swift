import Foundation

/// Compatibility profile from documentation and scoped capture schemas; synthetic values do not establish device parity.
public enum HEAEncoder {
    public static let metricNames = HEAMetricCatalog.names
    static let notificationIDs: Set<String> = ["HKCategoryTypeIdentifierHighHeartRateEvent", "HKCategoryTypeIdentifierLowHeartRateEvent", "HKCategoryTypeIdentifierIrregularHeartRhythmEvent"]

    static func family(for type: String, selection: HEADataType?) throws -> HEADataType {
        if type == "HKMedicationDoseEventTypeIdentifierMedicationDoseEvent" || type == "HKDataTypeUserAnnotatedMedicationConcept" {
            throw ConfigurationError("HEA 用药的疗程时间与剂量单位需要真实 HEA 抓包确认，请使用 HealthRelay JSON")
        }
        if ["HKCategoryTypeIdentifierAppleStandHour", "HKCategoryTypeIdentifierHandwashingEvent", "HKCategoryTypeIdentifierToothbrushingEvent"].contains(type) {
            throw ConfigurationError("HEA 计数或完成状态尚无可靠映射，需要真实 HEA 抓包，请使用 HealthRelay JSON：\(type)")
        }
        let automatic: HEADataType
        if metricNames[type] != nil { automatic = .healthMetrics }
        else if ["HKWorkoutType", "HKWorkoutTypeIdentifier"].contains(type) { automatic = .workouts }
        else if HEACategoryEncoder.symptoms[type] != nil { automatic = .symptoms }
        else if HEACategoryEncoder.cycle[type] != nil { automatic = .cycleTracking }
        else if notificationIDs.contains(type) { automatic = .heartRateNotifications }
        else if type == "HKDataTypeIdentifierElectrocardiogram" { automatic = .ecg }
        else if type == "HKDataTypeStateOfMind" { automatic = .stateOfMind }
        else { throw ConfigurationError("HEA 尚不支持该指标，请使用 HealthRelay JSON：\(type)") }
        guard let selection, selection != .automatic else { return automatic }
        if selection == automatic { return automatic }
        if type == "HKCategoryTypeIdentifierSexualActivity", selection == .cycleTracking { return selection }
        if type == "HKCategoryTypeIdentifierMenstrualFlow", selection == .symptoms { return selection }
        throw ConfigurationError("所选指标不属于 HEA \(selection.title)：\(type)")
    }

    public static func encode(_ batch: UploadBatch, timeZone: String, version: Int = 2, heaDataType: HEADataType? = nil) throws -> EncodedBatch {
        guard [1, 2].contains(version) else { throw ConfigurationError("未知 HEA 版本") }
        if heaDataType == .medications { throw ConfigurationError("HEA 用药需真实 HEA 抓包确认疗程与剂量单位，请使用 HealthRelay JSON") }
        let dates = try HEADates(timeZone: timeZone)
        var families: [HEADataType: [HealthRecord]] = [:]
        // Canonical record order keeps retries and equivalent batches deterministic.
        let records = batch.records.sorted { ($0.typeIdentifier, $0.start ?? "", $0.end ?? "", $0.recordId) < ($1.typeIdentifier, $1.start ?? "", $1.end ?? "", $1.recordId) }
        for record in records {
            guard record.op == .upsert else { throw ConfigurationError("HEA 格式不支持删除事件，请使用 HealthRelay JSON 同步删除") }
            guard record.payload != nil else { throw ConfigurationError("HEA 明细缺少数据") }
            let family = try family(for: record.typeIdentifier, selection: heaDataType)
            families[family, default: []].append(record)
        }
        var data: [String: JSONValue] = [:]
        for (family, records) in families {
            switch family {
            case .healthMetrics: data["metrics"] = .array(try metrics(records, dates: dates))
            case .workouts: data["workouts"] = .array(try records.map { try HEAWorkoutEncoder.encode($0, version: version, dates: dates) })
            case .symptoms, .cycleTracking: data[family.rawValue] = .array(try records.map { try HEACategoryEncoder.encode($0, family: family, dates: dates) })
            case .ecg, .heartRateNotifications, .stateOfMind: data[family.rawValue] = .array(try records.map { try HEASpecializedEncoder.encode($0, family: family, dates: dates) })
            case .automatic, .medications: throw ConfigurationError("HEA 数据类型不可执行")
            }
        }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return EncodedBatch(body: try encoder.encode(JSONValue.object(["data": .object(data)])), contentType: "application/json")
    }

    private static func metrics(_ all: [HealthRecord], dates: HEADates) throws -> [JSONValue] {
        func date(_ text: String?) throws -> String { try dates.string(text) }
        var metrics: [JSONValue] = []
        for type in Set(all.map(\.typeIdentifier)).sorted() {
            guard let name = metricNames[type] else { throw ConfigurationError("未知 HEA 指标") }
            let records = all.filter { $0.typeIdentifier == type }
            var points: [JSONValue] = [], unit: String?
            for record in records {
                let payload = record.payload!
                let metadata = payload["metadata"]?.object ?? [:]
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
                } else if type == "HKCategoryTypeIdentifierMindfulSession" {
                    _ = try HEAValue.enumName(payload["value"], [0: "Not Applicable"], type)
                    // Explicit duration-in-minutes profile; exact HEA raw export still needs capture.
                    unit = "min"; point["date"] = .string(try date(record.start)); point["qty"] = .number(try dates.interval(record) / 60)
                } else if type == "HKCategoryTypeIdentifierSexualActivity" {
                    _ = try HEAValue.enumName(payload["value"], [0: "Not Applicable"], type)
                    unit = "count"; point["date"] = .string(try date(record.start))
                    let protection = metadata["HKSexualActivityProtectionUsed"]
                    guard protection == nil || protection == .bool(true) || protection == .bool(false) else { throw ConfigurationError("HEA 性行为保护状态无效") }
                    point["Unspecified"] = .number(protection == nil ? 1 : 0)
                    point["Protection Used"] = .number(protection == .bool(true) ? 1 : 0)
                    point["Protection Not Used"] = .number(protection == .bool(false) ? 1 : 0)
                } else if type == "HKCorrelationTypeIdentifierBloodPressure" {
                    unit = "mmHg"; point["date"] = .string(try date(record.start))
                    guard let objects = payload["objects"]?.array else { throw ConfigurationError("HEA 血压缺少关联数据") }
                    for (suffix, key) in [("Systolic", "systolic"), ("Diastolic", "diastolic")] {
                        let children = objects.filter { $0.object?["typeIdentifier"] == .string("HKQuantityTypeIdentifierBloodPressure" + suffix) }
                        guard children.count == 1, let child = children[0].object?["payload"], let value = try HEAValue.quantity(child, unit: "mmHg").object?["qty"] else { throw ConfigurationError("HEA 血压必须包含同一关联内唯一的收缩压和舒张压") }
                        point[key] = value
                    }
                } else {
                    guard let code = payload["unit"]?.text else { throw ConfigurationError("HEA 数量明细缺少单位") }
                    let heart = ["HeartRate", "RestingHeartRate", "WalkingHeartRateAverage", "HeartRateRecoveryOneMinute"].contains(String(type.dropFirst("HKQuantityTypeIdentifier".count)))
                    let variability = type.contains("HeartRateVariability")
                    // Retain valid configured metric units except normalized HR/HRV; never merely relabel.
                    let allowed = MetricCatalog.bundled.metric(type)?.units ?? []
                    guard allowed.contains(code) || (heart && ["count/s", "bpm"].contains(code)) || (variability && code == "s") else { throw ConfigurationError("HEA 指标单位无效：\(type) / \(code)") }
                    let exportedUnit: String
                    if type == "HKQuantityTypeIdentifierHeartRate" {
                        // The observed generic heart-rate export uses count/min; workout HR has its own profile.
                        exportedUnit = "count/min"
                    } else { exportedUnit = heart ? "bpm" : variability ? "ms" : code }
                    guard unit == nil || unit == exportedUnit else { throw ConfigurationError("同一指标不能混用输出单位") }
                    unit = exportedUnit
                    func value(_ key: String) throws -> JSONValue {
                        let number = try HEAValue.number(payload[key], key)
                        let converted = try HEAValue.convert(number, from: code, to: exportedUnit)
                        // HealthKit percent is a fraction; retain HealthRelay display-percent profile pending capture.
                        return .number(code == "%" ? converted * 100 : converted)
                    }
                    point["date"] = .string(try date(record.start))
                    if type == "HKQuantityTypeIdentifierHeartRate" {
                        if aggregated {
                            // The captured aggregate shape has no source. Raw and other metrics retain it.
                            point.removeValue(forKey: "source")
                            for (native, hea) in [("minimum", "Min"), ("average", "Avg"), ("maximum", "Max")] {
                                if payload[native] != nil { point[hea] = try value(native) }
                            }
                            guard point["Min"] != nil || point["Avg"] != nil || point["Max"] != nil else { throw ConfigurationError("HEA 心率汇总缺少统计值") }
                        } else { let quantity = try value("value"); point["Min"] = quantity; point["Avg"] = quantity; point["Max"] = quantity }
                    } else { point["qty"] = try value("value") }
                    if type == "HKQuantityTypeIdentifierBloodGlucose" {
                        point["mealTime"] = .string(try metadata["HKBloodGlucoseMealTime"].map { try HEAValue.enumName($0, [1: "Before Meal", 2: "After Meal"], "mealTime") } ?? "Unspecified")
                    }
                    if type == "HKQuantityTypeIdentifierInsulinDelivery", let reason = metadata["HKInsulinDeliveryReason"] {
                        point["reason"] = .string(try HEAValue.enumName(reason, [1: "Basal", 2: "Bolus"], "reason"))
                    }
                }
                points.append(.object(point))
            }
            metrics.append(.object(["name": .string(name), "units": .string(unit ?? ""), "data": .array(points)]))
        }
        return metrics
    }
}
