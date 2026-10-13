import Foundation

extension JSONValue {
    var object: [String: JSONValue]? { if case .object(let value) = self { value } else { nil } }
    var array: [JSONValue]? { if case .array(let value) = self { value } else { nil } }
    var text: String? { if case .string(let value) = self { value } else { nil } }
    var number: Double? { if case .number(let value) = self, value.isFinite { value } else { nil } }
}

struct HEADates {
    let formatter: DateFormatter
    let milliseconds: DateFormatter
    init(timeZone: String) throws {
        guard let zone = TimeZone(identifier: timeZone) else { throw ConfigurationError("HEA 导出时区无效") }
        func make(_ format: String) -> DateFormatter {
            let value = DateFormatter(); value.locale = Locale(identifier: "en_US_POSIX")
            value.calendar = Calendar(identifier: .gregorian); value.timeZone = zone; value.dateFormat = format
            return value
        }
        formatter = make("yyyy-MM-dd HH:mm:ss Z"); milliseconds = make("yyyy-MM-dd HH:mm:ss.SSS Z")
    }
    func date(_ text: String?) throws -> Date {
        guard let value = AutomationConfig.parseDate(text) else { throw ConfigurationError("HEA 明细缺少合法时间") }
        return value
    }
    func string(_ text: String?) throws -> String { formatter.string(from: try date(text)) }
    func interval(_ record: HealthRecord) throws -> TimeInterval {
        let value = try date(record.end).timeIntervalSince(date(record.start))
        guard value >= 0 else { throw ConfigurationError("HEA 时间范围无效") }; return value
    }
}

enum HEAValue {
    static func number(_ value: JSONValue?, _ field: String) throws -> Double {
        guard let result = value?.number else { throw ConfigurationError("HEA 缺少合法数量：\(field)") }; return result
    }
    static func enumName(_ value: JSONValue?, _ names: [Int: String], _ field: String) throws -> String {
        let number = try number(value, field)
        guard number.rounded() == number, number >= Double(Int.min), number < Double(Int.max), let name = names[Int(number)] else {
            throw ConfigurationError("HEA 未知枚举：\(field) = \(number)，请使用 HealthRelay JSON")
        }; return name
    }
    static func convert(_ value: Double, from: String, to: String) throws -> Double {
        guard value.isFinite else { throw ConfigurationError("HEA 数值无效") }
        if from == to { return value }
        // Convert only known compatible dimensions; never relabel incompatible quantities.
        let scales: [[String: Double]] = [
            ["count/s": 60, "count/min": 1, "bpm": 1, "rpm": 1],
            ["s": 1, "ms": 0.001, "min": 60, "hr": 3600],
            ["m": 1, "km": 1000, "mi": 1609.344, "ft": 0.3048, "yd": 0.9144, "cm": 0.01, "in": 0.0254],
            ["m/s": 1, "km/hr": 1 / 3.6, "km/h": 1 / 3.6, "kmph": 1 / 3.6, "mi/hr": 0.44704, "mph": 0.44704],
            ["kcal": 1, "kJ": 1 / 4.184, "J": 1 / 4184],
            ["V": 1, "mV": 0.001, "uV": 0.000001], ["Hz": 1, "count/s": 1],
            ["mmHg": 1, "kPa": 7.500616827], ["MET": 1, "kcal/(hr*kg)": 1]
        ]
        var converted: Double?
        for dimension in scales {
            if let input = dimension[from], let output = dimension[to] { converted = value * input / output; break }
        }
        if from == "degF", to == "degC" { converted = (value - 32) * 5 / 9 }
        if from == "degC", to == "degF" { converted = value * 9 / 5 + 32 }
        guard let result = converted, result.isFinite else { throw ConfigurationError("HEA 不支持单位换算：\(from) → \(to)") }
        return result
    }
    static func quantity(_ native: JSONValue, unit: String) throws -> JSONValue {
        guard let object = native.object, let from = object["unit"]?.text else { throw ConfigurationError("HEA 数量缺少单位") }
        let value = try convert(number(object["value"], "value"), from: from, to: unit)
        return .object(["qty": .number(value), "units": .string(unit)])
    }
}
