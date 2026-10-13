import Foundation
import HealthKit
import CoreLocation
import HealthRelayCore

/// Query results keep native identities and load potentially large detail series lazily.
/// The closures are also the boundary for synthetic native tests; they never save data.
@MainActor struct WorkoutRouteData {
    let record: HealthRecord
    let count: Int
    let locations: () async throws -> [CLLocation]
}

@MainActor struct WorkoutQuantityData {
    let sample: HKQuantitySample
    let count: Int
    let series: () async throws -> [WorkoutQuantityPoint]
}

struct WorkoutQuantityPoint {
    let quantity: HKQuantity
    let interval: DateInterval
}

@MainActor struct WorkoutQueries {
    var routes: (HKSamplePredicate<HKWorkoutRoute>) async throws -> [WorkoutRouteData]
    var quantities: ([HKSamplePredicate<HKQuantitySample>]) async throws -> [WorkoutQuantityData]

    static func live(reader: HealthKitReader) -> Self {
        Self(routes: { predicate in
            let routes = try await HKSampleQueryDescriptor(predicates: [predicate], sortDescriptors: [SortDescriptor(\HKWorkoutRoute.startDate)], limit: nil).result(for: reader.health)
            return try routes.map { route in
                WorkoutRouteData(record: try reader.record(route, unit: nil), count: route.count, locations: {
                    try await WorkoutRouteRead(health: reader.health).read(route)
                })
            }
        }, quantities: { predicates in
            let samples = try await HKSampleQueryDescriptor(predicates: predicates, sortDescriptors: [SortDescriptor(\HKQuantitySample.startDate)], limit: nil).result(for: reader.health)
            return samples.map { sample in
                WorkoutQuantityData(sample: sample, count: sample.count, series: {
                    let descriptor = HKQuantitySeriesSampleQueryDescriptor(predicate: .quantitySample(type: sample.quantityType, predicate: HKQuery.predicateForObject(with: sample.uuid)))
                    var points: [WorkoutQuantityPoint] = []
                    for try await point in descriptor.results(for: reader.health) {
                        try Task.checkCancellation()
                        points.append(WorkoutQuantityPoint(quantity: point.quantity, interval: point.dateInterval))
                    }
                    return points
                })
            }
        })
    }
}

@MainActor enum WorkoutReader {
    // Workouts may associate any quantity (including hydration/nutrition). Permission
    // requests and queries use exactly this platform-supported catalog contract.
    static func metricTypes(reader: HealthKitReader) -> [HKQuantityType] {
        MetricCatalog.bundled.metrics.filter { $0.family == .quantity }
            .compactMap { try? reader.sampleType($0.id) as? HKQuantityType }
            .sorted { $0.identifier < $1.identifier }
    }

    static func read(_ workout: HKWorkout, reader: HealthKitReader, task: AutomationConfig, selection: MetricSelection) async throws -> HealthRecord {
        let options = task.data.workoutOptions ?? WorkoutOptions()
        var record = try reader.record(workout, unit: nil)
        let types = options.includeMetrics ? metricTypes(reader: reader) : []
        if options.includeMetrics {
            let summarized = Set(workout.allStatistics.keys).union(workout.workoutActivities.flatMap { $0.allStatistics.keys })
            let unread = summarized.subtracting(types).map(\.identifier).sorted()
            if !unread.isEmpty { record.payload?["unreadMetricTypes"] = .array(unread.map(JSONValue.string)) }
        }
        let queries = reader.workoutQueries ?? WorkoutQueries.live(reader: reader)
        let predicate = HKQuery.predicateForObjects(from: workout)
        func allowed(_ source: String) -> Bool {
            (selection.sources.isEmpty || selection.sources.contains(source)) && !task.data.excludedSources.contains(source)
        }
        return try await WorkoutExport.enrich(record, options: options, loadRoutes: {
            let routes = try await queries.routes(.workoutRoute(predicate))
            var records: [HealthRecord] = []
            for route in routes.filter({ allowed($0.record.source?.id ?? "") }).sorted(by: {
                ($0.record.start ?? "", $0.record.recordId) < ($1.record.start ?? "", $1.record.recordId)
            }) {
                try Task.checkCancellation()
                let points = try await route.locations()
                try Task.checkCancellation()
                guard points.count == route.count else { throw ConfigurationError("运动路线未完整读取，请重试") }
                var routeRecord = route.record
                routeRecord.payload = routeRecord.payload ?? [:]
                routeRecord.payload?["locations"] = .array(try locations(points))
                records.append(routeRecord)
            }
            return records
        }, loadMetrics: {
            let predicates = types.map { HKSamplePredicate.quantitySample(type: $0, predicate: predicate) }
            let samples = try await queries.quantities(predicates)
            var records: [HealthRecord] = []
            for data in samples where allowed(data.sample.sourceRevision.source.bundleIdentifier) {
                try Task.checkCancellation()
                let sample = data.sample
                var sampleRecord = try reader.record(sample, unit: nil)
                sampleRecord.payload?["aggregationStyle"] = .string(sample.quantityType.aggregationStyle == .cumulative ? "cumulative" : "discrete")
                sampleRecord.payload?["quantityCount"] = .number(Double(data.count))
                if data.count > 1 {
                    guard case .string(let code)? = sampleRecord.payload?["unit"] else { throw ConfigurationError("运动关联指标缺少单位") }
                    let unit = try HealthKitReader.unit(code)
                    let points = try await data.series()
                    try Task.checkCancellation()
                    guard points.count == data.count else { throw ConfigurationError("运动关联指标序列未完整读取，请重试") }
                    sampleRecord.payload?["series"] = .array(try points.map { point in
                        .object(["start": .string(HealthKitReader.date(point.interval.start)), "end": .string(HealthKitReader.date(point.interval.end)), "value": try number(point.quantity.doubleValue(for: unit))])
                    })
                }
                records.append(sampleRecord)
            }
            return records
        })
    }

    static func summary(_ workout: HKWorkout) throws -> [String: JSONValue] {
        var result: [String: JSONValue] = [
            "activityType": .number(Double(workout.workoutActivityType.rawValue)),
            "durationSeconds": try number(workout.duration),
            "events": .array(try (workout.workoutEvents ?? []).map { .object(try event($0)) }),
            "statistics": .object(try statistics(workout.allStatistics)),
            "activities": .array(try workout.workoutActivities.map { .object(try activity($0)) })]
        var totals: [String: JSONValue] = [:]
        // Legacy imported workouts can expose totals without associated quantity samples.
        for (name, value, code) in [("energyBurned", workout.totalEnergyBurned, "kcal"), ("distance", workout.totalDistance, "m"), ("swimmingStrokeCount", workout.totalSwimmingStrokeCount, "count"), ("flightsClimbed", workout.totalFlightsClimbed, "count")] {
            if let value { totals[name] = try quantity(value, preferredUnit: code) }
        }
        result["totals"] = .object(totals)
        return result
    }

    static func event(_ event: HKWorkoutEvent) throws -> [String: JSONValue] {
        ["type": .number(Double(event.type.rawValue)), "start": .string(HealthKitReader.date(event.dateInterval.start)), "end": .string(HealthKitReader.date(event.dateInterval.end)), "metadata": .object(try metadata(event.metadata))]
    }

    static func activity(_ activity: HKWorkoutActivity) throws -> [String: JSONValue] {
        let config = activity.workoutConfiguration
        var configuration: [String: JSONValue] = ["activityType": .number(Double(config.activityType.rawValue)), "locationType": .number(Double(config.locationType.rawValue)), "swimmingLocationType": .number(Double(config.swimmingLocationType.rawValue))]
        if let lap = config.lapLength { configuration["lapLength"] = try quantity(lap, preferredUnit: "m") }
        var result: [String: JSONValue] = ["id": .string(activity.uuid.uuidString.lowercased()), "start": .string(HealthKitReader.date(activity.startDate)), "durationSeconds": try number(activity.duration), "configuration": .object(configuration), "events": .array(try activity.workoutEvents.map { .object(try event($0)) }), "statistics": .object(try statistics(activity.allStatistics)), "metadata": .object(try metadata(activity.metadata))]
        if let end = activity.endDate { result["end"] = .string(HealthKitReader.date(end)) }
        return result
    }

    static func statistics(_ statistics: [HKQuantityType: HKStatistics]) throws -> [String: JSONValue] {
        var result: [String: JSONValue] = [:]
        for (type, stats) in statistics {
            let code = MetricCatalog.bundled.metric(type.identifier)?.units.first
            var values: [String: JSONValue] = ["start": .string(HealthKitReader.date(stats.startDate)), "end": .string(HealthKitReader.date(stats.endDate))]
            if let code { values["unit"] = .string(code) }
            for (name, value) in [("sum", stats.sumQuantity()), ("average", stats.averageQuantity()), ("minimum", stats.minimumQuantity()), ("maximum", stats.maximumQuantity()), ("mostRecent", stats.mostRecentQuantity())] {
                if let value {
                    if let code { values[name] = try number(value.doubleValue(for: HealthKitReader.unit(code))) }
                    else { values[name] = try quantity(value) }
                }
            }
            if let duration = stats.duration() { values["durationSeconds"] = try number(duration.doubleValue(for: .second())) }
            if let interval = stats.mostRecentQuantityDateInterval() { values["mostRecentInterval"] = .object(["start": .string(HealthKitReader.date(interval.start)), "end": .string(HealthKitReader.date(interval.end))]) }
            if let sources = stats.sources {
                values["sources"] = .array(try sources.sorted { $0.bundleIdentifier < $1.bundleIdentifier }.map { source in
                    var entry: [String: JSONValue] = ["id": .string(source.bundleIdentifier), "name": .string(source.name)]
                    for (name, value) in [("sum", stats.sumQuantity(for: source)), ("average", stats.averageQuantity(for: source)), ("minimum", stats.minimumQuantity(for: source)), ("maximum", stats.maximumQuantity(for: source)), ("mostRecent", stats.mostRecentQuantity(for: source))] {
                        if let value { entry[name] = try quantity(value, preferredUnit: code) }
                    }
                    if let duration = stats.duration(for: source) { entry["durationSeconds"] = try number(duration.doubleValue(for: .second())) }
                    if let interval = stats.mostRecentQuantityDateInterval(for: source) { entry["mostRecentInterval"] = .object(["start": .string(HealthKitReader.date(interval.start)), "end": .string(HealthKitReader.date(interval.end))]) }
                    return .object(entry)
                })
            }
            result[type.identifier] = .object(values)
        }
        return result
    }

    static func metadata(_ metadata: [String: Any]?) throws -> [String: JSONValue] {
        try (metadata ?? [:]).mapValuesWithKeys { key, value in
            if let quantity = value as? HKQuantity {
                let preferred: String?
                switch key {
                case HKMetadataKeyElevationAscended, HKMetadataKeyElevationDescended, HKMetadataKeyLapLength: preferred = "m"
                case HKMetadataKeyWeatherTemperature: preferred = "degC"
                case HKMetadataKeyWeatherHumidity: preferred = "%"
                case HKMetadataKeyAverageMETs: preferred = "kcal/(hr*kg)"
                default: preferred = nil
                }
                return try self.quantity(quantity, preferredUnit: preferred)
            }
            if let value = value as? String { return .string(value) }
            if let value = value as? Date { return .string(HealthKitReader.date(value)) }
            if let value = value as? NSNumber { return CFGetTypeID(value) == CFBooleanGetTypeID() ? .bool(value.boolValue) : try number(value.doubleValue) }
            if let value = value as? [String: Any] { return .object(try self.metadata(value)) }
            if let value = value as? [Any] { return .array(try value.map { try self.metadata(["value": $0])["value"]! }) }
            if let value = value as? Data { return .object(["type": .string("Data"), "base64": .string(value.base64EncodedString())]) }
            // Unexpected metadata remains visible and stops export instead of disappearing.
            throw ConfigurationError("尚未支持的运动 metadata 类型：\(key) (\(type(of: value)))")
        }
    }

    static func quantity(_ quantity: HKQuantity, preferredUnit: String? = nil) throws -> JSONValue {
        let candidates = [preferredUnit].compactMap { $0 } + ["m", "kcal", "kg", "s", "%", "count", "count/min", "degC", "W", "m/s", "kcal/(hr*kg)"] + MetricCatalog.bundled.metrics.flatMap(\.units)
        for code in candidates {
            let unit = try HealthKitReader.unit(code)
            if quantity.is(compatibleWith: unit) { return .object(["value": try number(quantity.doubleValue(for: unit)), "unit": .string(code)]) }
        }
        // HKQuantity does not expose its unit; secure coding preserves unfamiliar dimensions.
        return .object(["type": .string("HKQuantity"), "archive": .string(try NSKeyedArchiver.archivedData(withRootObject: quantity, requiringSecureCoding: true).base64EncodedString())])
    }

    static func locations(_ locations: [CLLocation]) throws -> [JSONValue] {
        try locations.enumerated().sorted { ($0.element.timestamp, $0.offset) < ($1.element.timestamp, $1.offset) }.map { _, point in
            var value: [String: JSONValue] = ["timestamp": .string(HealthKitReader.date(point.timestamp))]
            for (key, number) in [("latitude", point.coordinate.latitude), ("longitude", point.coordinate.longitude), ("altitude", point.altitude), ("ellipsoidalAltitude", point.ellipsoidalAltitude), ("horizontalAccuracy", point.horizontalAccuracy), ("verticalAccuracy", point.verticalAccuracy), ("course", point.course), ("courseAccuracy", point.courseAccuracy), ("speed", point.speed), ("speedAccuracy", point.speedAccuracy)] { value[key] = try self.number(number) }
            if let floor = point.floor { value["floor"] = .number(Double(floor.level)) }
            if let source = point.sourceInformation { value["sourceInformation"] = .object(["isSimulatedBySoftware": .bool(source.isSimulatedBySoftware), "isProducedByAccessory": .bool(source.isProducedByAccessory)]) }
            return .object(value)
        }
    }

    static func number(_ value: Double) throws -> JSONValue {
        guard value.isFinite else { throw ConfigurationError("健康数据含非有限数值，已停止导出") }
        return .number(value)
    }
}

/// The HealthKit callback consumes each batch synchronously before the next callback can
/// finish the stream. The lock also serializes cancellation from another executor.
final class WorkoutRouteCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var locations: [CLLocation] = []
    private var failure: Error?
    func cancel() { lock.withLock { failure = CancellationError(); locations.removeAll() } }
    func receive(_ points: [CLLocation]?, done: Bool, error: Error?) throws -> [CLLocation]? {
        try lock.withLock {
            if let failure { throw failure }
            if let error { failure = error; locations.removeAll(); throw error }
            if let points { locations.append(contentsOf: points) }
            return done ? locations : nil
        }
    }
}

private final class WorkoutRouteRead: @unchecked Sendable {
    private let health: HKHealthStore
    private let collector = WorkoutRouteCollector()
    private let lock = NSLock()
    private var query: HKWorkoutRouteQuery?
    private var continuation: CheckedContinuation<[CLLocation], Error>?
    private var cancelled = false
    init(health: HKHealthStore) { self.health = health }

    func read(_ route: HKWorkoutRoute) async throws -> [CLLocation] {
        try await withTaskCancellationHandler {
            try Task.checkCancellation()
            let result = try await withCheckedThrowingContinuation { continuation in
                let query = HKWorkoutRouteQuery(route: route) { [self] _, locations, done, error in
                    do { if let complete = try collector.receive(locations, done: done, error: error) { finish(.success(complete)) } }
                    catch { finish(.failure(error)) }
                }
                let start = lock.withLock {
                    if cancelled { return false }
                    self.continuation = continuation
                    self.query = query
                    return true
                }
                guard start else { continuation.resume(throwing: CancellationError()); return }
                health.execute(query)
                // Cancellation may race with execute after the continuation was installed.
                if lock.withLock({ cancelled }) { health.stop(query) }
            }
            try Task.checkCancellation()
            return result
        } onCancel: {
            self.lock.withLock { self.cancelled = true }
            self.collector.cancel()
            self.finish(.failure(CancellationError()))
        }
    }
    private func finish(_ result: Result<[CLLocation], Error>) {
        let pending = lock.withLock { () -> (CheckedContinuation<[CLLocation], Error>, HKWorkoutRouteQuery?)? in
            guard let continuation else { return nil }
            let query = self.query
            self.continuation = nil; self.query = nil
            return (continuation, query)
        }
        guard let (continuation, query) = pending else { return }
        if let query { health.stop(query) }
        continuation.resume(with: result)
    }
}

private extension Dictionary where Key == String, Value == Any {
    func mapValuesWithKeys(_ transform: (String, Any) throws -> JSONValue) rethrows -> [String: JSONValue] {
        var result: [String: JSONValue] = [:]
        for (key, value) in self { result[key] = try transform(key, value) }
        return result
    }
}
