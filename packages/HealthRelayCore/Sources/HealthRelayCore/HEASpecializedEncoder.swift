import Foundation

enum HEASpecializedEncoder {
    static let classifications: [Int: String] = [1: "Sinus Rhythm", 2: "Atrial Fibrillation", 3: "Inconclusive Low Heart Rate", 4: "Inconclusive High Heart Rate", 5: "Inconclusive Poor Recording", 6: "Inconclusive", 100: "Unrecognized"]
    static let kinds: [Int: String] = [1: "momentary_emotion", 2: "daily_mood"]
    static let labels: [Int: String] = [1: "amazed", 2: "amused", 3: "angry", 4: "anxious", 5: "ashamed", 6: "brave", 7: "calm", 8: "content", 9: "disappointed", 10: "discouraged", 11: "disgusted", 12: "embarrassed", 13: "excited", 14: "frustrated", 15: "grateful", 16: "guilty", 17: "happy", 18: "hopeless", 19: "irritated", 20: "jealous", 21: "joyful", 22: "lonely", 23: "passionate", 24: "peaceful", 25: "proud", 26: "relieved", 27: "sad", 28: "scared", 29: "stressed", 30: "surprised", 31: "worried", 32: "annoyed", 33: "confident", 34: "drained", 35: "hopeful", 36: "indifferent", 37: "overwhelmed", 38: "satisfied"]
    static let associations: [Int: String] = [1: "community", 2: "current_events", 3: "dating", 4: "education", 5: "family", 6: "fitness", 7: "friends", 8: "health", 9: "hobbies", 10: "identity", 11: "money", 12: "partner", 13: "self_care", 14: "spirituality", 15: "tasks", 16: "travel", 17: "work", 18: "weather"]
    static let valences: [Int: String] = [1: "very_unpleasant", 2: "unpleasant", 3: "slightly_unpleasant", 4: "neutral", 5: "slightly_pleasant", 6: "pleasant", 7: "very_pleasant"]

    static func encode(_ record: HealthRecord, family: HEADataType, dates: HEADates) throws -> JSONValue {
        guard let payload = record.payload else { throw ConfigurationError("HEA 明细缺少数据") }
        _ = try dates.interval(record)
        var result: [String: JSONValue] = ["start": .string(try dates.string(record.start)), "end": .string(try dates.string(record.end))]
        switch family {
        case .ecg:
            result["classification"] = .string(try HEAValue.enumName(payload["classification"], classifications, "classification"))
            for (field, unit) in [("averageHeartRate", "bpm"), ("samplingFrequency", "Hz")] {
                guard let quantity = payload[field] else { throw ConfigurationError("HEA 心电图缺少 \(field)，请使用 HealthRelay JSON") }
                result[field] = try HEAValue.quantity(quantity, unit: unit).object?["qty"]
            }
            guard let voltages = payload["voltageMeasurements"]?.array else { throw ConfigurationError("HEA 心电图缺少波形") }
            let count = try HEAValue.number(payload["numberOfVoltageMeasurements"], "numberOfVoltageMeasurements")
            guard count == Double(voltages.count) else { throw ConfigurationError("HEA 心电图波形未完整读取") }
            result["numberOfVoltageMeasurements"] = .number(count)
            let start = try dates.date(record.start)
            result["voltageMeasurements"] = .array(try voltages.map { point in
                guard let point = point.object, let unit = point["unit"]?.text else { throw ConfigurationError("HEA 心电图电压无效") }
                let offset = try HEAValue.number(point["offsetMilliseconds"], "offsetMilliseconds")
                guard offset >= 0 else { throw ConfigurationError("HEA 心电图时间偏移无效") }
                let voltage = try HEAValue.convert(HEAValue.number(point["voltage"], "voltage"), from: unit, to: "V")
                return .object(["date": .string(dates.milliseconds.string(from: start.addingTimeInterval(offset / 1000))), "voltage": .number(voltage), "units": .string("V")])
            })
            result["source"] = .string(record.source?.name ?? "unknown")
            // symptomsStatus is symptom presence, not severity: no established crosswalk.
        case .stateOfMind:
            result["start"] = .string(HealthTimestamp.string(try dates.date(record.start)))
            result["end"] = .string(HealthTimestamp.string(try dates.date(record.end)))
            result["id"] = .string(record.recordId)
            result["kind"] = .string(try HEAValue.enumName(payload["kind"], kinds, "kind"))
            result["valenceClassification"] = .string(try HEAValue.enumName(payload["valenceClassification"], valences, "valenceClassification"))
            result["valence"] = .number(try HEAValue.number(payload["valence"], "valence"))
            for (field, names) in [("labels", labels), ("associations", associations)] {
                guard let values = payload[field]?.array else { throw ConfigurationError("HEA 心理状态缺少 \(field)") }
                result[field] = .array(try values.map { .string(try HEAValue.enumName($0, names, field)) })
            }
            // Documented HEA metadata only permits strings; native JSON retains all typed metadata.
            if let metadata = payload["metadata"]?.object {
                let strings = metadata.filter { $0.value.text != nil }
                if !strings.isEmpty { result["metadata"] = .object(strings) }
            }
        case .heartRateNotifications:
            _ = try HEAValue.enumName(payload["value"], [0: "Not Applicable"], "notification")
            if record.typeIdentifier != "HKCategoryTypeIdentifierIrregularHeartRhythmEvent", let threshold = payload["metadata"]?.object?["HKHeartRateEventThreshold"] {
                result["threshold"] = try HEAValue.quantity(threshold, unit: "bpm").object?["qty"]
            }
            var heart: [JSONValue] = [], variation: [JSONValue] = []
            // Native reader supplies the explicit overlap-event-interval-v1 policy.
            // Do not claim this is HEA's undocumented association window or query extra data.
            for value in payload["associatedQuantities"]?.array ?? [] {
                let child = try JSONDecoder().decode(HealthRecord.self, from: JSONEncoder().encode(value))
                guard child.op == .upsert, let data = child.payload, let unit = data["unit"]?.text else { throw ConfigurationError("HEA 通知关联数量无效") }
                let isHR = child.typeIdentifier == "HKQuantityTypeIdentifierHeartRate"
                guard isHR || child.typeIdentifier == "HKQuantityTypeIdentifierHeartRateVariabilitySDNN" else { throw ConfigurationError("HEA 通知关联指标尚不支持") }
                let observations = data["series"]?.array ?? [.object(["start": child.start.map(JSONValue.string) ?? .null, "end": child.end.map(JSONValue.string) ?? .null, "value": data["value"] ?? .null])]
                for observation in observations {
                    guard let point = observation.object else { throw ConfigurationError("HEA 通知关联序列无效") }
                    let start = try dates.date(point["start"]?.text), end = try dates.date(point["end"]?.text)
                    guard end >= start else { throw ConfigurationError("HEA 通知关联时间范围无效") }
                    let outputUnit = isHR ? "bpm" : "ms"
                    let quantity = try HEAValue.convert(HEAValue.number(point["value"], "value"), from: unit, to: outputUnit)
                    let output: JSONValue = .object([isHR ? "hr" : "hrv": .number(quantity), "units": .string(outputUnit), "timestamp": .object(["start": .string(dates.formatter.string(from: start)), "end": .string(dates.formatter.string(from: end)), "interval": .object(["duration": .number(end.timeIntervalSince(start)), "units": .string("s")])])])
                    if isHR { heart.append(output) } else { variation.append(output) }
                }
            }
            result["heartRate"] = .array(heart); result["heartRateVariation"] = .array(variation)
            // No notification-kind field in the HEA contract.
        default: throw ConfigurationError("未知 HEA 特殊数据类型")
        }
        return .object(result)
    }
}
