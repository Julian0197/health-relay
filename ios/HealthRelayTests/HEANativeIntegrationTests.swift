import XCTest
import HealthKit
import CoreLocation
import HealthRelayCore
#if os(watchOS)
@testable import HealthRelayWatch
#else
@testable import HealthRelay
#endif

/// Bridges actual public HealthKit objects and the production read-page path to HEA.
/// Query closures supply synthetic data; these tests do not read a real health store.
@MainActor final class HEANativeIntegrationTests: XCTestCase {
    func testWorkoutPageEncodesRoutesMetricsAndLegacyTotalsInBothVersions() async throws {
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        let workout = HKWorkout(activityType: .running, start: start, end: start.addingTimeInterval(600),
            workoutEvents: nil, totalEnergyBurned: HKQuantity(unit: .kilocalorie(), doubleValue: 100),
            totalDistance: HKQuantity(unit: .meter(), doubleValue: 1500), metadata: nil)
        let heartRate = HKQuantitySample(type: HKQuantityType(.heartRate),
            quantity: HKQuantity(unit: HKUnit.count().unitDivided(by: .minute()), doubleValue: 135),
            start: start, end: start.addingTimeInterval(1))
        let location = CLLocation(coordinate: CLLocationCoordinate2D(latitude: 22, longitude: 113),
            altitude: 42, horizontalAccuracy: 3, verticalAccuracy: 4, course: 75, courseAccuracy: 1,
            speed: 5, speedAccuracy: 0.5, timestamp: start)
        let route = HealthRecord(op: .upsert, typeIdentifier: "HKWorkoutRouteTypeIdentifier", recordId: "synthetic-route",
            start: HealthTimestamp.string(start), end: HealthTimestamp.string(start),
            source: RecordSource(id: "test.fixture", name: "Fixture"), payload: [:])
        let reader = HealthKitReader(workoutQueries: WorkoutQueries(
            routes: { _ in [WorkoutRouteData(record: route, count: 1, locations: { [location] })] },
            quantities: { _ in [WorkoutQuantityData(sample: heartRate, count: 1, series: { XCTFail("Scalar sample has no series query"); return [] })] }))
        var task = AutomationConfig(); task.data.family = .workout
        task.data.selections = [MetricSelection(typeIdentifier: "HKWorkoutType")]
        var options = WorkoutOptions(); options.includeRoutes = true; options.includeMetrics = true
        task.data.workoutOptions = options
        let page = try await reader.makePage(samples: [workout], deletedIDs: [], anchor: Data([7]), hasMore: false,
            end: nil, task: task, selection: task.data.selections[0])
        for format in ["hea.v1", "hea.v2"] {
            let encoded = try BatchEncoder.encode(UploadBatch(task: task, records: page.records), format: format)
            let item = try firstItem(encoded, family: "workouts")
            XCTAssertEqual(item["name"] as? String, "Running")
            let energyKey = format == "hea.v1" ? "activeEnergy" : "activeEnergyBurned"
            XCTAssertEqual((item[energyKey] as? [String: Any])?["qty"] as? Double, 100)
            XCTAssertNil(item["totalEnergy"], "Absent basal energy must remain absent")
            let routePoints = try XCTUnwrap(item["route"] as? [[String: Any]])
            XCTAssertEqual(routePoints.count, 1)
            XCTAssertEqual(routePoints[0][format == "hea.v1" ? "lat" : "latitude"] as? Double, 22)
            let points = try XCTUnwrap(item["heartRateData"] as? [[String: Any]])
            XCTAssertEqual(points.count, 1)
            XCTAssertEqual(points[0][format == "hea.v1" ? "qty" : "Avg"] as? Double, 135)
        }
    }

    func testNativeStateOfMindEnumsAndMetadataEncode() throws {
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        let sample = HKStateOfMind(date: start, kind: .dailyMood, valence: 0.2,
            labels: [.calm, .content], associations: [.health, .work], metadata: ["origin": "synthetic"])
        let record = try HealthKitReader().record(sample, unit: nil)
        let encoded = try BatchEncoder.encode(UploadBatch(task: AutomationConfig(), records: [record]), format: "hea.v2")
        let item = try firstItem(encoded, family: "stateOfMind")
        XCTAssertEqual(item["id"] as? String, sample.uuid.uuidString.lowercased())
        XCTAssertEqual(item["kind"] as? String, "daily_mood")
        XCTAssertEqual(item["labels"] as? [String], ["calm", "content"])
        XCTAssertEqual(item["associations"] as? [String], ["health", "work"])
        XCTAssertEqual(item["valence"] as? Double, 0.2)
        XCTAssertEqual((item["metadata"] as? [String: String])?["origin"], "synthetic")
        XCTAssertEqual(AutomationConfig.parseDate(item["start"] as? String), start)
    }

    private func firstItem(_ encoded: EncodedBatch, family: String) throws -> [String: Any] {
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded.body) as? [String: Any])
        let data = try XCTUnwrap(root["data"] as? [String: Any])
        return try XCTUnwrap((data[family] as? [[String: Any]])?.first)
    }
}
