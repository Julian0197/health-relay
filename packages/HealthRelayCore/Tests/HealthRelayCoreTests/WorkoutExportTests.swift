import XCTest
@testable import HealthRelayCore

@MainActor final class WorkoutExportTests: XCTestCase {
    func testNativeWorkoutOptionsAreExecutable() {
        var task = AutomationConfig.newTask()
        task.data.family = .workout
        task.data.selections = [MetricSelection(typeIdentifier: "HKWorkoutType")]
        var options = WorkoutOptions(); options.includeRoutes = true; options.includeMetrics = true
        task.data.workoutOptions = options
        XCTAssertEqual(task.executionCapabilityIssues, [])
    }
}

extension WorkoutExportTests {
    private func sample(_ id: String, _ seconds: Double, _ value: Double, type: String = "HKQuantityTypeIdentifierHeartRate", unit: String = "count/min") -> HealthRecord {
        HealthRecord(op: .upsert, typeIdentifier: type, recordId: id, start: HealthTimestamp.string(Date(timeIntervalSince1970: seconds)), end: HealthTimestamp.string(Date(timeIntervalSince1970: seconds + 1)), source: RecordSource(id: "watch", name: "Watch"), payload: ["value": .number(value), "unit": .string(unit)])
    }
    func testMinuteGroupingKeepsRawSamplesAndHeartRateExtrema() throws {
        let samples = [sample("b", 121, 130), sample("c", 182, 100), sample("a", 120, 110)]
        let metrics = try WorkoutExport.metricSeries(samples: samples, grouping: "minutes")
        guard case .object(let heart)? = metrics["HKQuantityTypeIdentifierHeartRate"], case .array(let data)? = heart["data"] else { return XCTFail("Missing heart series") }
        XCTAssertEqual(heart["unit"], .string("count/min"))
        XCTAssertEqual(heart["aggregation"], .string("discrete"))
        XCTAssertEqual(data.count, 2)
        guard case .object(let first) = data[0], case .array(let raw)? = heart["samples"] else { return XCTFail("Missing raw data") }
        XCTAssertEqual(first["average"], .number(120)); XCTAssertEqual(first["minimum"], .number(110)); XCTAssertEqual(first["maximum"], .number(130))
        XCTAssertEqual(first["start"], .string("1970-01-01T00:02:00.000Z"))
        let decoded = try JSONDecoder().decode([HealthRecord].self, from: JSONEncoder().encode(raw))
        XCTAssertEqual(decoded.map(\.recordId), ["a", "b", "c"])
        XCTAssertEqual(decoded.first?.source, samples.first?.source)
    }
    func testCumulativeSamplesAreSummedOnceInTheirStartBucket() throws {
        let samples = [sample("b", 120.9, 5, type: "HKQuantityTypeIdentifierActiveEnergyBurned", unit: "kcal"), sample("a", 120.1, 3, type: "HKQuantityTypeIdentifierActiveEnergyBurned", unit: "kcal"), sample("c", 121, 2, type: "HKQuantityTypeIdentifierActiveEnergyBurned", unit: "kcal")]
        let series = try WorkoutExport.metricSeries(samples: samples, grouping: "seconds")
        guard case .object(let energy)? = series["HKQuantityTypeIdentifierActiveEnergyBurned"], case .array(let data)? = energy["data"], case .object(let first) = data[0] else { return XCTFail("Missing energy") }
        XCTAssertEqual(energy["aggregation"], .string("cumulative")); XCTAssertEqual(data.count, 2)
        XCTAssertEqual(first["sum"], .number(8)); XCTAssertNil(first["average"])
        XCTAssertEqual(first["count"], .number(2))
    }
    func testQuantitySeriesUsesIndividualObservationsInsteadOfParentAverage() throws {
        var record = sample("series-parent", 120, 120)
        record.payload?["series"] = .array([
            .object(["start": .string("1970-01-01T00:02:00.000Z"), "end": .string("1970-01-01T00:02:00.000Z"), "value": .number(100)]),
            .object(["start": .string("1970-01-01T00:02:01.000Z"), "end": .string("1970-01-01T00:02:01.000Z"), "value": .number(140)])])
        let metrics = try WorkoutExport.metricSeries(samples: [record], grouping: "seconds")
        guard case .object(let heart)? = metrics[record.typeIdentifier], case .array(let data)? = heart["data"] else { return XCTFail("Missing series") }
        XCTAssertEqual(data.count, 2)
        guard case .object(let first) = data[0] else { return XCTFail("Missing first observation") }
        XCTAssertEqual(first["average"], .number(100))
    }
    func testOverlappingSourcesStaySeparateWithinSameBucket() throws {
        let watch = sample("watch", 120, 100)
        var strap = sample("strap", 120, 140)
        strap.source = RecordSource(id: "strap", name: "Chest strap")
        let metrics = try WorkoutExport.metricSeries(samples: [watch, strap], grouping: "minutes")
        guard case .object(let heart)? = metrics[watch.typeIdentifier], case .array(let data)? = heart["data"] else { return XCTFail("Missing source buckets") }
        XCTAssertEqual(data.count, 2)
        let points = data.compactMap { if case .object(let point) = $0 { return point }; return nil }
        XCTAssertEqual(Set(points.compactMap { if case .string(let source)? = $0["sourceId"] { return source }; return nil }), Set(["watch", "strap"]))
        XCTAssertTrue(points.contains { $0["sourceId"] == .string("strap") && $0["average"] == .number(140) && $0["source"] == .string("Chest strap") })
    }
    func testRejectsInvalidGroupingMixedUnitsAndNonfiniteValues() {
        XCTAssertThrowsError(try WorkoutExport.metricSeries(samples: [], grouping: "hours"))
        XCTAssertThrowsError(try WorkoutExport.metricSeries(samples: [sample("a", 1, .infinity)], grouping: "minutes"))
        XCTAssertThrowsError(try WorkoutExport.metricSeries(samples: [sample("a", 1, 120), sample("b", 1, 2, unit: "count/s")], grouping: "minutes"))
    }
    func testDisabledOptionsPreserveLegacySummaryWithoutLoadingDetails() async throws {
        let record = HealthRecord(op: .upsert, typeIdentifier: "HKWorkoutType", recordId: "w", payload: ["activityType": .number(37), "durationSeconds": .number(600)])
        let result = try await WorkoutExport.enrich(record, options: WorkoutOptions(), loadRoutes: { XCTFail("Routes must not be queried"); return [] }, loadMetrics: { XCTFail("Metrics must not be queried"); return [] })
        XCTAssertEqual(result, record)
    }
    func testFailedDetailsDoNotReturnPartiallyEnrichedRecord() async {
        var options = WorkoutOptions(); options.includeRoutes = true; options.includeMetrics = true
        let record = HealthRecord(op: .upsert, typeIdentifier: "HKWorkoutType", recordId: "w")
        do {
            _ = try await WorkoutExport.enrich(record, options: options, loadRoutes: { [] }, loadMetrics: { throw ConfigurationError("query failed") })
            XCTFail("Partial workout must not escape to a page/anchor")
        } catch { XCTAssertEqual(error.localizedDescription, "query failed") }
    }
    func testCancellationStopsBeforeDetailQueries() async {
        let task = Task { @MainActor in
            withUnsafeCurrentTask { $0?.cancel() }
            return try await WorkoutExport.enrich(HealthRecord(op: .upsert, typeIdentifier: "HKWorkoutType", recordId: "w"), options: WorkoutOptions(), loadRoutes: { XCTFail("Cancelled"); return [] }, loadMetrics: { XCTFail("Cancelled"); return [] })
        }
        do { _ = try await task.value; XCTFail("Cancellation must propagate") } catch { XCTAssertTrue(error is CancellationError) }
    }
}
