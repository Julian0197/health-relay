import XCTest
import HealthKit
import CoreLocation
import HealthRelayCore
#if os(watchOS)
@testable import HealthRelayWatch
#else
@testable import HealthRelay
#endif

@MainActor final class WorkoutReaderTests: XCTestCase {
    let start = Date(timeIntervalSince1970: 1_800_000_000)

    func testLegacyWorkoutRetainsTotalsEventMetadataAndQuantityMetadata() throws {
        let event = HKWorkoutEvent(type: .marker, dateInterval: DateInterval(start: start, duration: 0), metadata: ["customMarker": "water"])
        let workout = HKWorkout(activityType: .running, start: start, end: start.addingTimeInterval(600), workoutEvents: [event], totalEnergyBurned: HKQuantity(unit: .kilocalorie(), doubleValue: 100), totalDistance: HKQuantity(unit: .meter(), doubleValue: 1500), metadata: [HKMetadataKeyElevationAscended: HKQuantity(unit: .foot(), doubleValue: 100), "customKey": "retained", HKMetadataKeyWeatherHumidity: HKQuantity(unit: .percent(), doubleValue: 0.5)])
        let record = try HealthKitReader().record(workout, unit: nil)
        XCTAssertEqual(record.recordId, workout.uuid.uuidString.lowercased())
        XCTAssertEqual(record.typeIdentifier, "HKWorkoutType")
        XCTAssertEqual(record.payload?["durationSeconds"], .number(600))
        guard case .object(let totals)? = record.payload?["totals"], case .object(let metadata)? = record.payload?["metadata"], case .array(let events)? = record.payload?["events"], case .object(let first) = events[0] else { return XCTFail("Missing workout structure") }
        XCTAssertEqual(totals["distance"], .object(["value": .number(1500), "unit": .string("m")]))
        XCTAssertEqual(metadata["customKey"], .string("retained"))
        guard case .object(let elevation)? = metadata[HKMetadataKeyElevationAscended], case .number(let meters)? = elevation["value"] else { return XCTFail("Quantity metadata lost") }
        XCTAssertEqual(meters, 30.48, accuracy: 0.0001); XCTAssertEqual(elevation["unit"], .string("m"))
        XCTAssertEqual(metadata[HKMetadataKeyWeatherHumidity], .object(["value": .number(0.5), "unit": .string("%")]))
        XCTAssertEqual(first["metadata"], .object(["customMarker": .string("water")]))
        XCTAssertNil(record.payload?["routes"]); XCTAssertNil(record.payload?["metrics"])
    }

    func testQuantitySampleKeepsNativeIdentitySourceAndMetadata() throws {
        let sample = HKQuantitySample(type: HKQuantityType(.heartRate), quantity: HKQuantity(unit: HKUnit.count().unitDivided(by: .minute()), doubleValue: 123), start: start, end: start.addingTimeInterval(1), metadata: ["sensor": "test"])
        let record = try HealthKitReader().record(sample, unit: nil)
        XCTAssertEqual(record.recordId, sample.uuid.uuidString.lowercased())
        XCTAssertEqual(record.source?.id, sample.sourceRevision.source.bundleIdentifier)
        XCTAssertEqual(record.payload?["value"], .number(123)); XCTAssertEqual(record.payload?["unit"], .string("count/min"))
        XCTAssertEqual(record.payload?["metadata"], .object(["sensor": .string("test")]))
    }

    func testProductionHeartRatePageKeepsScalarAndParentDeletionIdentity() async throws {
        let sample = HKQuantitySample(type: HKQuantityType(.heartRate), quantity: HKQuantity(unit: HKUnit.count().unitDivided(by: .minute()), doubleValue: 72), start: start, end: start)
        var task = AutomationConfig.newTask()
        task.data.selections = [MetricSelection(typeIdentifier: sample.quantityType.identifier, unit: "count/min")]
        let deletedID = UUID()
        let page = try await HealthKitReader().makePage(samples: [sample], deletedIDs: [deletedID], anchor: Data([3]), hasMore: false, end: nil, task: task, selection: task.data.selections[0])
        XCTAssertEqual(page.records.map(\.recordId), [sample.uuid.uuidString.lowercased(), deletedID.uuidString.lowercased()])
        XCTAssertEqual(page.records.map(\.op), [.upsert, .delete])
        XCTAssertEqual(page.records.first?.payload?["value"], .number(72))
        XCTAssertEqual(page.records.first?.payload?["quantityCount"], .number(1))
        XCTAssertNil(page.records.first?.payload?["series"])
        XCTAssertEqual(page.anchor, Data([3]))
    }

    private func heartRateTask() -> AutomationConfig {
        var task = AutomationConfig.newTask()
        task.data.selections = [MetricSelection(typeIdentifier: HKQuantityTypeIdentifier.heartRate.rawValue, unit: "count/min")]
        return task
    }

    func testProductionHeartRatePageExportsRealSeriesUnderParentIdentity() async throws {
        let unit = HKUnit.count().unitDivided(by: .minute())
        let sample = HKQuantitySample(type: HKQuantityType(.heartRate), quantity: HKQuantity(unit: unit, doubleValue: 90), start: start, end: start.addingTimeInterval(620), metadata: ["sensor": "test"])
        let points = [
            WorkoutQuantityPoint(quantity: HKQuantity(unit: unit, doubleValue: 60), interval: DateInterval(start: start.addingTimeInterval(5), duration: 2)),
            WorkoutQuantityPoint(quantity: HKQuantity(unit: HKUnit.count().unitDivided(by: .second()), doubleValue: 1.5), interval: DateInterval(start: start.addingTimeInterval(70), duration: 0)),
            WorkoutQuantityPoint(quantity: HKQuantity(unit: unit, doubleValue: 120), interval: DateInterval(start: start.addingTimeInterval(610), duration: 1))]
        var reads = 0
        let reader = HealthKitReader(quantityData: { parent in
            XCTAssertEqual(parent.uuid, sample.uuid)
            return WorkoutQuantityData(sample: parent, count: points.count, series: { reads += 1; return points })
        })
        let task = heartRateTask()
        let page = try await reader.makePage(samples: [sample], deletedIDs: [], anchor: Data([7]), hasMore: true, end: nil, task: task, selection: task.data.selections[0])
        let record = try XCTUnwrap(page.records.first)
        XCTAssertEqual(page.records.count, 1)
        XCTAssertEqual(record.recordId, sample.uuid.uuidString.lowercased())
        XCTAssertEqual(record.source?.id, sample.sourceRevision.source.bundleIdentifier)
        XCTAssertEqual(record.payload?["metadata"], .object(["sensor": .string("test")]))
        XCTAssertEqual(record.payload?["quantityCount"], .number(3))
        XCTAssertEqual(record.payload?["series"], .array(points.enumerated().map { index, point in
            .object(["start": .string(HealthKitReader.date(point.interval.start)), "end": .string(HealthKitReader.date(point.interval.end)), "value": .number([60, 90, 120][index])])
        }))
        XCTAssertEqual(reads, 1)
        XCTAssertEqual(page.anchor, Data([7])); XCTAssertTrue(page.hasMore)
    }

    func testProductionScalarAndExcludedHeartRateDoNotReadSeries() async throws {
        let sample = HKQuantitySample(type: HKQuantityType(.heartRate), quantity: HKQuantity(unit: HKUnit.count().unitDivided(by: .minute()), doubleValue: 72), start: start, end: start)
        let reader = HealthKitReader(quantityData: { parent in
            WorkoutQuantityData(sample: parent, count: 1, series: { XCTFail("Scalar sample must not query a series"); return [] })
        })
        var task = heartRateTask()
        let page = try await reader.makePage(samples: [sample], deletedIDs: [], anchor: Data([1]), hasMore: false, end: nil, task: task, selection: task.data.selections[0])
        XCTAssertNil(page.records.first?.payload?["series"])
        task.data.excludedSources = [sample.sourceRevision.source.bundleIdentifier]
        let excludedReader = HealthKitReader(quantityData: { parent in
            XCTFail("Excluded sample must not load quantity details")
            return WorkoutQuantityData(sample: parent, count: 2, series: { [] })
        })
        let excluded = try await excludedReader.makePage(samples: [sample], deletedIDs: [], anchor: Data([2]), hasMore: true, end: nil, task: task, selection: task.data.selections[0])
        XCTAssertTrue(excluded.records.isEmpty); XCTAssertEqual(excluded.anchor, Data([2]))
    }

    func testHEAHeartRatePageDoesNotReadNativeSeries() async throws {
        let sample = HKQuantitySample(type: HKQuantityType(.heartRate), quantity: HKQuantity(unit: HKUnit.count().unitDivided(by: .minute()), doubleValue: 72), start: start, end: start.addingTimeInterval(60))
        let reader = HealthKitReader(quantityData: { parent in
            XCTFail("HEA exports must keep their scalar query path")
            return WorkoutQuantityData(sample: parent, count: 2, series: { [] })
        })
        var task = heartRateTask(); task.export.format = "hea.v2"
        let page = try await reader.makePage(samples: [sample], deletedIDs: [], anchor: Data([4]), hasMore: false, end: nil, task: task, selection: task.data.selections[0])
        XCTAssertEqual(page.records.first?.payload?["value"], .number(72))
        XCTAssertNil(page.records.first?.payload?["series"])
        XCTAssertNil(page.records.first?.payload?["quantityCount"])
    }

    func testAggregateHeartRatePageDoesNotReadNativeSeries() async throws {
        let sample = HKQuantitySample(type: HKQuantityType(.heartRate), quantity: HKQuantity(unit: HKUnit.count().unitDivided(by: .minute()), doubleValue: 72), start: start, end: start.addingTimeInterval(60))
        let reader = HealthKitReader(quantityData: { parent in
            XCTFail("Aggregate exports must keep their existing quantity query path")
            return WorkoutQuantityData(sample: parent, count: 2, series: { [] })
        })
        var task = heartRateTask(); task.export.mode = .aggregate; task.export.grouping = .minutes; task.export.statistics = [.average]
        let page = try await reader.makePage(samples: [sample], deletedIDs: [], anchor: Data([5]), hasMore: false, end: nil, task: task, selection: task.data.selections[0])
        XCTAssertEqual(page.records.first?.payload?["value"], .number(72))
        XCTAssertNil(page.records.first?.payload?["series"])
        XCTAssertNil(page.records.first?.payload?["quantityCount"])
    }

    func testFailedHeartRateSeriesPreventsPartialPageAndAnchorReturn() async {
        let unit = HKUnit.count().unitDivided(by: .minute())
        let first = HKQuantitySample(type: HKQuantityType(.heartRate), quantity: HKQuantity(unit: unit, doubleValue: 70), start: start, end: start)
        let second = HKQuantitySample(type: HKQuantityType(.heartRate), quantity: HKQuantity(unit: unit, doubleValue: 80), start: start, end: start.addingTimeInterval(60))
        let reader = HealthKitReader(quantityData: { sample in
            WorkoutQuantityData(sample: sample, count: sample.uuid == first.uuid ? 1 : 2, series: { throw ConfigurationError("heart rate series failed") })
        })
        let task = heartRateTask()
        var page: ReadPage?
        do { page = try await reader.makePage(samples: [first, second], deletedIDs: [UUID()], anchor: Data([99]), hasMore: false, end: nil, task: task, selection: task.data.selections[0]); XCTFail("Failed series must prevent page") }
        catch { XCTAssertEqual(error.localizedDescription, "heart rate series failed") }
        XCTAssertNil(page)
    }

    func testIncompleteHeartRateSeriesPreventsPageAndAnchorReturn() async {
        let quantity = HKQuantity(unit: HKUnit.count().unitDivided(by: .minute()), doubleValue: 80)
        let sample = HKQuantitySample(type: HKQuantityType(.heartRate), quantity: quantity, start: start, end: start.addingTimeInterval(60))
        let reader = HealthKitReader(quantityData: { parent in
            WorkoutQuantityData(sample: parent, count: 2, series: { [WorkoutQuantityPoint(quantity: quantity, interval: DateInterval(start: self.start, duration: 1))] })
        })
        let task = heartRateTask()
        do { _ = try await reader.makePage(samples: [sample], deletedIDs: [], anchor: Data([99]), hasMore: false, end: nil, task: task, selection: task.data.selections[0]); XCTFail("Incomplete series must prevent page") }
        catch { XCTAssertEqual(error.localizedDescription, "心率序列未完整读取，请重试") }
    }

    func testCancelledHeartRateSeriesPreventsPageAndAnchorReturn() async {
        let quantity = HKQuantity(unit: HKUnit.count().unitDivided(by: .minute()), doubleValue: 80)
        let sample = HKQuantitySample(type: HKQuantityType(.heartRate), quantity: quantity, start: start, end: start.addingTimeInterval(60))
        let reader = HealthKitReader(quantityData: { parent in
            WorkoutQuantityData(sample: parent, count: 2, series: {
                withUnsafeCurrentTask { $0?.cancel() }
                return [WorkoutQuantityPoint(quantity: quantity, interval: DateInterval(start: self.start, duration: 1)), WorkoutQuantityPoint(quantity: quantity, interval: DateInterval(start: self.start.addingTimeInterval(30), duration: 1))]
            })
        })
        let config = heartRateTask()
        let task = Task { try await reader.makePage(samples: [sample], deletedIDs: [], anchor: Data([99]), hasMore: false, end: nil, task: config, selection: config.data.selections[0]) }
        do { _ = try await task.value; XCTFail("Cancelled series must prevent page") }
        catch { XCTAssertTrue(error is CancellationError) }
    }

    func testHeartRateSeriesRejectsIncompatibleUnitsAndNonfiniteValues() async {
        let unit = HKUnit.count().unitDivided(by: .minute())
        let sample = HKQuantitySample(type: HKQuantityType(.heartRate), quantity: HKQuantity(unit: unit, doubleValue: 80), start: start, end: start.addingTimeInterval(60))
        let task = heartRateTask()
        for invalid in [HKQuantity(unit: .meter(), doubleValue: 2), HKQuantity(unit: unit, doubleValue: .infinity)] {
            let reader = HealthKitReader(quantityData: { parent in
                WorkoutQuantityData(sample: parent, count: 2, series: { [WorkoutQuantityPoint(quantity: invalid, interval: DateInterval(start: self.start, duration: 1)), WorkoutQuantityPoint(quantity: invalid, interval: DateInterval(start: self.start.addingTimeInterval(30), duration: 1))] })
            })
            do { _ = try await reader.makePage(samples: [sample], deletedIDs: [], anchor: Data([99]), hasMore: false, end: nil, task: task, selection: task.data.selections[0]); XCTFail("Invalid quantity must prevent page") }
            catch { XCTAssertTrue(error is ConfigurationError) }
        }
    }

    func testActivityConfigurationAndMetadataSurvive() throws {
        let config = HKWorkoutConfiguration(); config.activityType = .swimming; config.locationType = .indoor
        config.swimmingLocationType = .pool; config.lapLength = HKQuantity(unit: .meter(), doubleValue: 25)
        let activity = HKWorkoutActivity(workoutConfiguration: config, start: start, end: start.addingTimeInterval(90), metadata: ["segment": "warmup"])
        let value = try WorkoutReader.activity(activity)
        XCTAssertEqual(value["id"], .string(activity.uuid.uuidString.lowercased()))
        XCTAssertEqual(value["metadata"], .object(["segment": .string("warmup")]))
        guard case .object(let configuration)? = value["configuration"] else { return XCTFail("Missing configuration") }
        XCTAssertEqual(configuration["lapLength"], .object(["value": .number(25), "unit": .string("m")]))
    }

    func testMultipleRouteCallbacksPreserveAllLocationsAndSortByTime() throws {
        let first = CLLocation(coordinate: CLLocationCoordinate2D(latitude: 22, longitude: 113), altitude: 42, horizontalAccuracy: 3, verticalAccuracy: 4, course: 75, courseAccuracy: 1, speed: 5, speedAccuracy: 0.5, timestamp: start)
        let second = CLLocation(coordinate: CLLocationCoordinate2D(latitude: 23, longitude: 114), altitude: 43, horizontalAccuracy: -1, verticalAccuracy: -1, course: -1, courseAccuracy: -1, speed: -1, speedAccuracy: -1, timestamp: start.addingTimeInterval(1))
        let collector = WorkoutRouteCollector()
        XCTAssertNil(try collector.receive([second], done: false, error: nil))
        let locations = try XCTUnwrap(collector.receive([first], done: true, error: nil))
        let values = try WorkoutReader.locations(locations)
        XCTAssertEqual(values.count, 2)
        guard case .object(let location) = values[0], case .object(let invalidAccuracy) = values[1] else { return XCTFail("Missing locations") }
        XCTAssertEqual(location["latitude"], .number(22)); XCTAssertEqual(location["altitude"], .number(42))
        XCTAssertEqual(location["horizontalAccuracy"], .number(3)); XCTAssertEqual(location["verticalAccuracy"], .number(4))
        XCTAssertEqual(location["course"], .number(75)); XCTAssertEqual(location["courseAccuracy"], .number(1))
        XCTAssertEqual(location["speed"], .number(5)); XCTAssertEqual(location["speedAccuracy"], .number(0.5))
        XCTAssertNotNil(location["ellipsoidalAltitude"])
        XCTAssertEqual(invalidAccuracy["speed"], .number(-1), "HealthKit invalid-value sentinels must remain available")
    }

    func testRouteFailureNeverReturnsPartialLocations() throws {
        let collector = WorkoutRouteCollector()
        XCTAssertNil(try collector.receive([CLLocation(latitude: 1, longitude: 2)], done: false, error: nil))
        XCTAssertThrowsError(try collector.receive(nil, done: true, error: ConfigurationError("route failed")))
    }

    func testRouteCancellationNeverReturnsPartialLocations() throws {
        let collector = WorkoutRouteCollector()
        XCTAssertNil(try collector.receive([CLLocation(latitude: 1, longitude: 2)], done: false, error: nil))
        collector.cancel()
        XCTAssertThrowsError(try collector.receive([], done: true, error: nil)) { XCTAssertTrue($0 is CancellationError) }
    }

    func testNonfiniteLocationAndMetadataAreRejected() {
        XCTAssertThrowsError(try WorkoutReader.locations([CLLocation(coordinate: CLLocationCoordinate2D(latitude: 1, longitude: 2), altitude: .infinity, horizontalAccuracy: 1, verticalAccuracy: 1, timestamp: start)]))
        XCTAssertThrowsError(try WorkoutReader.metadata(["invalid": NSNumber(value: Double.infinity)]))
    }

    func testWorkoutPermissionsFollowSelectedOptions() throws {
        var task = AutomationConfig.newTask(); task.data.family = .workout; task.data.selections = [MetricSelection(typeIdentifier: "HKWorkoutType")]
        let reader = HealthKitReader()
        XCTAssertEqual(try reader.authorizationTypes(task), [HKObjectType.workoutType()])
        var options = WorkoutOptions(); options.includeRoutes = true; task.data.workoutOptions = options
        XCTAssertTrue(try reader.authorizationTypes(task).contains(HKSeriesType.workoutRoute()))
        XCTAssertFalse(try reader.authorizationTypes(task).contains(HKQuantityType(.heartRate)))
        options.includeMetrics = true; task.data.workoutOptions = options
        XCTAssertTrue(try reader.authorizationTypes(task).contains(HKQuantityType(.heartRate)))
        XCTAssertTrue(try reader.authorizationTypes(task).contains(HKQuantityType(.cyclingPower)))
    }
    func testEveryRequestedWorkoutQuantityIsInTheReadContractIncludingDietaryWater() throws {
        var task = AutomationConfig.newTask(); task.data.family = .workout
        task.data.selections = [MetricSelection(typeIdentifier: "HKWorkoutType")]
        var options = WorkoutOptions(); options.includeMetrics = true; task.data.workoutOptions = options
        let reader = HealthKitReader()
        let requested = Set(try reader.authorizationTypes(task).compactMap { $0 as? HKQuantityType })
        let queried = Set(WorkoutReader.metricTypes(reader: reader))
        XCTAssertEqual(requested, queried)
        XCTAssertTrue(queried.contains(HKQuantityType(.dietaryWater)), "A known associated quantity must have permission before it is queried")
    }

}

extension WorkoutReaderTests {
    private func workoutTask() -> AutomationConfig {
        var task = AutomationConfig.newTask(); task.data.family = .workout
        task.data.selections = [MetricSelection(typeIdentifier: "HKWorkoutType")]
        var options = WorkoutOptions(); options.includeRoutes = true; options.includeMetrics = true
        task.data.workoutOptions = options
        return task
    }
    private func routeRecord(_ id: String, offset: Double, source: String) -> HealthRecord {
        HealthRecord(op: .upsert, typeIdentifier: "HKWorkoutRouteTypeIdentifier", recordId: id,
            start: HealthTimestamp.string(start.addingTimeInterval(offset)), end: HealthTimestamp.string(start.addingTimeInterval(offset + 1)),
            source: RecordSource(id: source, name: source), payload: ["metadata": .object(["segment": .string(id)])])
    }
    func testProductionPageReadsAllAllowedRoutesAndQuantitySeriesUsingAssociation() async throws {
        let workout = HKWorkout(activityType: .running, start: start, end: start.addingTimeInterval(600))
        let quantity = HKQuantitySample(type: HKQuantityType(.heartRate), quantity: HKQuantity(unit: HKUnit.count().unitDivided(by: .minute()), doubleValue: 120), start: start, end: start.addingTimeInterval(1))
        let relation = HKQuery.predicateForObjects(from: workout)
        var observedTypes = Set<HKQuantityType>(), routeLoads = 0, seriesLoads = 0
        var task = workoutTask(); task.data.excludedSources = ["excluded"]
        let queries = WorkoutQueries(routes: { predicate in
            XCTAssertEqual(predicate.nsPredicate, relation)
            return [
                WorkoutRouteData(record: self.routeRecord("second", offset: 10, source: "allowed"), count: 1, locations: { routeLoads += 1; return [CLLocation(latitude: 2, longitude: 3)] }),
                WorkoutRouteData(record: self.routeRecord("excluded", offset: 5, source: "excluded"), count: 1, locations: { XCTFail("Excluded route must not load locations"); return [] }),
                WorkoutRouteData(record: self.routeRecord("first", offset: 0, source: "allowed"), count: 1, locations: { routeLoads += 1; return [CLLocation(latitude: 1, longitude: 2)] })]
        }, quantities: { predicates in
            observedTypes = Set(predicates.compactMap { $0.sampleType as? HKQuantityType })
            XCTAssertTrue(predicates.allSatisfy { $0.nsPredicate == relation })
            return [WorkoutQuantityData(sample: quantity, count: 2, series: {
                seriesLoads += 1
                return [100.0, 140.0].enumerated().map { index, value in
                    WorkoutQuantityPoint(quantity: HKQuantity(unit: HKUnit.count().unitDivided(by: .minute()), doubleValue: value), interval: DateInterval(start: self.start.addingTimeInterval(Double(index)), duration: 0))
                }
            })]
        })
        let reader = HealthKitReader(workoutQueries: queries)
        let anchor = Data("proposed-anchor".utf8)
        let page = try await reader.makePage(samples: [workout], deletedIDs: [], anchor: anchor, hasMore: true, end: nil, task: task, selection: task.data.selections[0])
        XCTAssertEqual(page.anchor, anchor); XCTAssertTrue(page.hasMore)
        XCTAssertEqual(routeLoads, 2); XCTAssertEqual(seriesLoads, 1)
        XCTAssertEqual(observedTypes, Set(try reader.authorizationTypes(task).compactMap { $0 as? HKQuantityType }))
        XCTAssertTrue(observedTypes.contains(HKQuantityType(.dietaryWater)))
        let payload = try XCTUnwrap(page.records.first?.payload)
        let routes = try JSONDecoder().decode([HealthRecord].self, from: JSONEncoder().encode(payload["routes"]))
        XCTAssertEqual(routes.map(\.recordId), ["first", "second"])
        guard case .object(let metrics)? = payload["metrics"], case .object(let heart)? = metrics[quantity.quantityType.identifier], case .array(let data)? = heart["data"], case .object(let point) = data.first else { return XCTFail("Missing grouped series") }
        XCTAssertEqual(point["minimum"], .number(100)); XCTAssertEqual(point["maximum"], .number(140))
        let raw = try JSONDecoder().decode([HealthRecord].self, from: JSONEncoder().encode(heart["samples"]))
        XCTAssertEqual(raw.first?.recordId, quantity.uuid.uuidString.lowercased())
        XCTAssertEqual(raw.first?.payload?["quantityCount"], .number(2))
        XCTAssertNil(payload["unreadMetricTypes"])
    }

    func testProductionPageDoesNotQueryExcludedWorkout() async throws {
        let workout = HKWorkout(activityType: .running, start: start, end: start.addingTimeInterval(600))
        var task = workoutTask(); task.data.excludedSources = [workout.sourceRevision.source.bundleIdentifier]
        let reader = HealthKitReader(workoutQueries: WorkoutQueries(routes: { _ in XCTFail("Excluded workout"); return [] }, quantities: { _ in XCTFail("Excluded workout"); return [] }))
        let page = try await reader.makePage(samples: [workout], deletedIDs: [], anchor: Data([1]), hasMore: true, end: nil, task: task, selection: task.data.selections[0])
        XCTAssertTrue(page.records.isEmpty); XCTAssertEqual(page.anchor, Data([1])); XCTAssertTrue(page.hasMore)
    }

    func testProductionWorkoutFiltersExcludedQuantityBeforeSeriesRead() async throws {
        let workout = HKWorkout(activityType: .running, start: start, end: start.addingTimeInterval(600))
        let sample = HKQuantitySample(type: HKQuantityType(.dietaryWater), quantity: HKQuantity(unit: .literUnit(with: .milli), doubleValue: 200), start: start, end: start)
        var task = workoutTask(); task.data.excludedSources = [sample.sourceRevision.source.bundleIdentifier]
        let reader = HealthKitReader(workoutQueries: WorkoutQueries(routes: { _ in [] }, quantities: { _ in [WorkoutQuantityData(sample: sample, count: 2, series: { XCTFail("Excluded quantity must not load series"); return [] })] }))
        let record = try await WorkoutReader.read(workout, reader: reader, task: task, selection: task.data.selections[0])
        XCTAssertEqual(record.payload?["metrics"], .object([:]))
    }

    func testFailedRouteDetailsPreventProductionPageAndAnchorReturn() async {
        let workout = HKWorkout(activityType: .running, start: start, end: start.addingTimeInterval(600)), task = workoutTask()
        let reader = HealthKitReader(workoutQueries: WorkoutQueries(routes: { _ in [WorkoutRouteData(record: self.routeRecord("bad", offset: 0, source: "allowed"), count: 1, locations: { throw ConfigurationError("route query failed") })] }, quantities: { _ in XCTFail("Stop after failed route"); return [] }))
        var page: ReadPage?
        do { page = try await reader.makePage(samples: [workout], deletedIDs: [UUID()], anchor: Data([99]), hasMore: false, end: nil, task: task, selection: task.data.selections[0]); XCTFail("Failed details must prevent page") }
        catch { XCTAssertEqual(error.localizedDescription, "route query failed") }
        XCTAssertNil(page)
    }

    func testCancelledDetailsPreventProductionPageAndAnchorReturn() async {
        let workout = HKWorkout(activityType: .running, start: start, end: start.addingTimeInterval(600)), config = workoutTask()
        let reader = HealthKitReader(workoutQueries: WorkoutQueries(routes: { _ in withUnsafeCurrentTask { $0?.cancel() }; return [] }, quantities: { _ in XCTFail("Cancelled before metrics"); return [] }))
        let task = Task { try await reader.makePage(samples: [workout], deletedIDs: [], anchor: Data([99]), hasMore: false, end: nil, task: config, selection: config.data.selections[0]) }
        do { _ = try await task.value; XCTFail("Cancelled details must prevent page") } catch { XCTAssertTrue(error is CancellationError) }
    }

    func testIncompleteQuantitySeriesPreventsProductionPageReturn() async {
        let workout = HKWorkout(activityType: .running, start: start, end: start.addingTimeInterval(600)), task = workoutTask()
        let sample = HKQuantitySample(type: HKQuantityType(.heartRate), quantity: HKQuantity(unit: HKUnit.count().unitDivided(by: .minute()), doubleValue: 120), start: start, end: start)
        let reader = HealthKitReader(workoutQueries: WorkoutQueries(routes: { _ in [] }, quantities: { _ in [WorkoutQuantityData(sample: sample, count: 2, series: { [] })] }))
        do { _ = try await reader.makePage(samples: [workout], deletedIDs: [], anchor: Data([99]), hasMore: false, end: nil, task: task, selection: task.data.selections[0]); XCTFail("Incomplete series must prevent page") }
        catch { XCTAssertEqual(error.localizedDescription, "运动关联指标序列未完整读取，请重试") }
    }
}
