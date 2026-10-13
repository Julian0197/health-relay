import Foundation

/// Native workout details retain original records alongside deterministic display buckets.
public enum WorkoutExport {
    private struct Bucket: Hashable {
        let start: TimeInterval
        let sourceId: String?
    }
    public static func metricSeries(samples: [HealthRecord], grouping: String) throws -> [String: JSONValue] {
        let interval: TimeInterval
        switch grouping {
        case "seconds": interval = 1
        case "minutes": interval = 60
        default: throw ConfigurationError("运动指标仅支持按秒或分钟分组")
        }
        var result: [String: JSONValue] = [:]
        for (type, records) in Dictionary(grouping: samples, by: \.typeIdentifier) {
            let sorted = records.sorted { ($0.start ?? "", $0.recordId) < ($1.start ?? "", $1.recordId) }
            guard case .string(let unit)? = sorted.first?.payload?["unit"] else { throw ConfigurationError("运动指标缺少单位：\(type)") }
            let cumulative = sorted.first?.payload?["aggregationStyle"] == .string("cumulative") || MetricCatalog.bundled.metric(type)?.statistics == [.sum]
            var buckets: [Bucket: [Double]] = [:]
            var sourceNames: [String: String] = [:]
            for sample in sorted {
                guard sample.payload?["unit"] == .string(unit) else { throw ConfigurationError("运动指标包含混合单位：\(type)") }
                if let source = sample.source { sourceNames[source.id] = source.name }
                let observations: [[String: JSONValue]]
                if case .array(let series)? = sample.payload?["series"] {
                    observations = try series.map {
                        guard case .object(let point) = $0 else { throw ConfigurationError("运动指标序列无效：\(type)") }
                        return point
                    }
                } else {
                    observations = [["start": sample.start.map(JSONValue.string) ?? .null, "value": sample.payload?["value"] ?? .null]]
                }
                for observation in observations {
                    guard case .number(let value)? = observation["value"], value.isFinite,
                          case .string(let text)? = observation["start"], let date = AutomationConfig.parseDate(text),
                          date.timeIntervalSince1970.isFinite else { throw ConfigurationError("运动指标包含无效数值或时间：\(type)") }
                    // Assign each observation once by start time; never invent values between observations.
                    let bucket = floor(date.timeIntervalSince1970 / interval) * interval
                    buckets[Bucket(start: bucket, sourceId: sample.source?.id), default: []].append(value)
                }
            }
            let data: [JSONValue] = try buckets.keys.sorted { ($0.start, $0.sourceId ?? "") < ($1.start, $1.sourceId ?? "") }.map { bucket in
                let start = bucket.start
                let values = buckets[bucket]!
                let sum = values.reduce(0, +)
                guard sum.isFinite else { throw ConfigurationError("运动指标分组超出可表示范围：\(type)") }
                var point: [String: JSONValue] = ["start": .string(HealthTimestamp.string(Date(timeIntervalSince1970: start))), "end": .string(HealthTimestamp.string(Date(timeIntervalSince1970: start + interval))), "count": .number(Double(values.count))]
                if let sourceId = bucket.sourceId {
                    point["sourceId"] = .string(sourceId)
                    if let name = sourceNames[sourceId] { point["source"] = .string(name) }
                }
                if cumulative { point["sum"] = .number(sum) }
                else {
                    point["average"] = .number(sum / Double(values.count))
                    point["minimum"] = .number(values.min()!)
                    point["maximum"] = .number(values.max()!)
                }
                return .object(point)
            }
            result[type] = .object(["unit": .string(unit), "grouping": .string(grouping), "aggregation": .string(cumulative ? "cumulative" : "discrete"), "samples": try json(sorted), "data": .array(data)])
        }
        return result
    }

    @MainActor public static func enrich(_ record: HealthRecord, options: WorkoutOptions,
        loadRoutes: () async throws -> [HealthRecord], loadMetrics: () async throws -> [HealthRecord]) async throws -> HealthRecord {
        try Task.checkCancellation()
        var result = record
        if options.includeRoutes {
            let routes = try await loadRoutes()
            try Task.checkCancellation()
            result.payload = (result.payload ?? [:]).merging(["routes": try json(routes)]) { _, value in value }
        }
        if options.includeMetrics {
            let samples = try await loadMetrics()
            try Task.checkCancellation()
            result.payload = (result.payload ?? [:]).merging(["metrics": .object(try metricSeries(samples: samples, grouping: options.metricGrouping))]) { _, value in value }
        }
        try Task.checkCancellation()
        return result
    }

    public static func json<T: Encodable>(_ value: T) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value))
    }
}
