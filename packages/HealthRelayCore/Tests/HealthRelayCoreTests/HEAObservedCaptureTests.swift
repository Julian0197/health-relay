import Foundation
import XCTest
@testable import HealthRelayCore

final class HEAObservedCaptureTests: XCTestCase {
    private let heartRate = "HKQuantityTypeIdentifierHeartRate"
    private let formats = ["hea.v1", "hea.v2"]

    private struct Fixture: Decodable {
        var timeZone: String
        var records: [HealthRecord]
        var expected: JSONValue
    }

    private func record(_ payload: [String: JSONValue], type: String = "HKQuantityTypeIdentifierHeartRate") -> HealthRecord {
        HealthRecord(op: .upsert, typeIdentifier: type, recordId: "synthetic-sample",
                     start: "2000-01-01T00:00:00Z", end: "2000-01-01T00:01:00Z",
                     source: RecordSource(id: "synthetic.watch", name: "Synthetic Watch"), payload: payload)
    }

    private func encode(_ records: [HealthRecord], format: String, timeZone: String = "UTC") throws -> JSONValue {
        let encoded = try BatchEncoder.encode(UploadBatch(task: .newTask(), records: records), format: format, timeZone: timeZone)
        XCTAssertEqual(encoded.contentType, "application/json")
        return try JSONDecoder().decode(JSONValue.self, from: encoded.body)
    }

    func testAggregateHeartRateMatchesObservedCaptureShapeInBothJSONVersions() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "observed-heart-rate-aggregate", withExtension: "json", subdirectory: "Fixtures/hea"))
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        for format in formats {
            let actual = try encode(fixture.records, format: format, timeZone: fixture.timeZone)
            XCTAssertEqual(actual, fixture.expected, format)
            let metric = try XCTUnwrap(actual.object?["data"]?.object?["metrics"]?.array?.first?.object)
            XCTAssertEqual(metric["units"], .string("count/min"), format)
            for point in try XCTUnwrap(metric["data"]?.array) {
                XCTAssertEqual(Set(try XCTUnwrap(point.object).keys), ["Avg", "Max", "Min", "date"], format)
            }
        }
    }

    func testAggregateHeartRateConvertsToCountPerMinuteWithoutRelabeling() throws {
        for format in formats {
            for (unit, scale) in [("count/s", 1.0), ("count/min", 60.0), ("bpm", 60.0)] {
                let sample = record(["aggregation": .bool(true), "unit": .string(unit),
                                     "minimum": .number(scale), "average": .number(1.5 * scale), "maximum": .number(2 * scale)])
                let result = try encode([sample], format: format)
                let metric = try XCTUnwrap(result.object?["data"]?.object?["metrics"]?.array?.first?.object)
                XCTAssertEqual(metric["units"], .string("count/min"), "\(format) / \(unit)")
                XCTAssertEqual(metric["data"]?.array?.first, .object([
                    "date": .string("2000-01-01 00:00:00 +0000"), "Min": .number(60), "Avg": .number(90), "Max": .number(120)
                ]), "\(format) / \(unit)")
            }
        }
    }

    func testRawHeartRateRetainsSourceAndNormalizesUnits() throws {
        for format in formats {
            for source in [RecordSource(id: "synthetic.watch", name: "Synthetic Watch"), nil] {
                var sample = record(["unit": .string("count/s"), "value": .number(1.5)])
                sample.source = source
                let result = try encode([sample], format: format)
                let metric = try XCTUnwrap(result.object?["data"]?.object?["metrics"]?.array?.first?.object)
                XCTAssertEqual(metric["units"], .string("count/min"), format)
                XCTAssertEqual(metric["data"]?.array?.first, .object([
                    "date": .string("2000-01-01 00:00:00 +0000"), "Min": .number(90), "Avg": .number(90), "Max": .number(90),
                    "source": .string(source?.name ?? "unknown")
                ]), format)
            }
        }
    }

    func testObservedHeartRateProfileDoesNotChangeOtherAggregatedMetrics() throws {
        for format in formats {
            for suffix in ["RestingHeartRate", "WalkingHeartRateAverage", "HeartRateRecoveryOneMinute"] {
                let sample = record(["aggregation": .bool(true), "unit": .string("count/s"), "value": .number(1.5)], type: "HKQuantityTypeIdentifier" + suffix)
                let result = try encode([sample], format: format)
                let metric = try XCTUnwrap(result.object?["data"]?.object?["metrics"]?.array?.first?.object)
                XCTAssertEqual(metric["units"], .string("bpm"), suffix)
                XCTAssertEqual(metric["data"]?.array?.first, .object([
                    "date": .string("2000-01-01 00:00:00 +0000"), "qty": .number(90), "source": .string("Synthetic Watch")
                ]), suffix)
            }
        }
    }

    func testMixedHealthAndWorkoutHeartRateKeepSeparateUnitProfiles() throws {
        let health = record(["aggregation": .bool(true), "unit": .string("count/s"), "average": .number(1.5)])
        let workout = record([
            "activityType": .number(37), "durationSeconds": .number(60),
            "statistics": .object([heartRate: .object(["unit": .string("count/s"), "average": .number(1.5)])]),
            "metrics": .object([heartRate: .object(["unit": .string("count/s"), "data": .array([.object([
                "start": .string("2000-01-01T00:00:00Z"), "minimum": .number(1), "average": .number(1.5), "maximum": .number(2), "source": .string("Synthetic Watch")
            ])])])])
        ], type: "HKWorkoutType")
        for format in formats {
            let root = try encode([health, workout], format: format)
            let data = try XCTUnwrap(root.object?["data"]?.object)
            XCTAssertEqual(data["metrics"]?.array?.first?.object?["units"], .string("count/min"), format)
            let exercise = try XCTUnwrap(data["workouts"]?.array?.first?.object)
            let point = try XCTUnwrap(exercise["heartRateData"]?.array?.first?.object)
            XCTAssertEqual(point["units"], .string(format == "hea.v1" ? "count" : "bpm"), format)
            XCTAssertEqual(point[format == "hea.v1" ? "qty" : "Avg"], .number(90), format)
            XCTAssertEqual(point["source"], format == "hea.v1" ? nil : .string("Synthetic Watch"), format)
            if format == "hea.v2" {
                XCTAssertEqual(exercise["avgHeartRate"], .object(["qty": .number(90), "units": .string("bpm")]))
            }
        }
    }
}
