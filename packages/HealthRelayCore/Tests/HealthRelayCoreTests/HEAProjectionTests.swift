import Foundation
import XCTest
@testable import HealthRelayCore

final class HEAProjectionTests: XCTestCase {
    func record(_ payload: [String: JSONValue], type: String = "HKWorkoutType") -> HealthRecord {
        HealthRecord(op: .upsert, typeIdentifier: type, recordId: "workout", start: "2026-01-01T00:00:00Z", end: "2026-01-01T00:10:00Z", payload: payload)
    }
    func workout(_ payload: [String: JSONValue], version: Int = 2) throws -> [String: JSONValue] {
        let data = try HEAEncoder.encode(UploadBatch(task: .newTask(), records: [record(payload)]), timeZone: "UTC", version: version)
        let root = try JSONDecoder().decode(JSONValue.self, from: data.body)
        return try XCTUnwrap(root.object?["data"]?.object?["workouts"]?.array?.first?.object)
    }
    func quantity(_ value: Double, _ unit: String) -> JSONValue { .object(["value": .number(value), "unit": .string(unit)]) }
    func output(_ value: Double, _ unit: String) -> JSONValue { .object(["qty": .number(value), "units": .string(unit)]) }

    func testWorkoutSummaryUsesStatisticsBeforeLegacyTotalsAndConvertsMetadata() throws {
        let payload: [String: JSONValue] = ["activityType": .number(46), "durationSeconds": .number(540), "statistics": .object([
            "HKQuantityTypeIdentifierActiveEnergyBurned": .object(["sum": .number(418.4), "unit": .string("kJ")]),
            "HKQuantityTypeIdentifierBasalEnergyBurned": .object(["sum": .number(83.68), "unit": .string("kJ")]),
            "HKQuantityTypeIdentifierDistanceSwimming": .object(["sum": .number(1500), "unit": .string("m")]),
            "HKQuantityTypeIdentifierFlightsClimbed": .object(["sum": .number(8), "unit": .string("count")]),
            "HKQuantityTypeIdentifierSwimmingStrokeCount": .object(["sum": .number(90), "unit": .string("count")]),
            "HKQuantityTypeIdentifierHeartRate": .object(["minimum": .number(1), "average": .number(2), "maximum": .number(3), "unit": .string("count/s")])]),
            "totals": .object(["energyBurned": quantity(999, "kcal"), "distance": quantity(2000, "m"), "flightsClimbed": quantity(999, "count")]),
            "metadata": .object(["HKElevationAscended": quantity(100, "ft"), "HKElevationDescended": quantity(20, "m"), "HKWeatherTemperature": quantity(68, "degF"), "HKWeatherHumidity": quantity(0.65, "%"), "HKAverageMETs": quantity(5, "kcal/(hr*kg)"), "HKLapLength": quantity(50, "m"), "HKAverageSpeed": quantity(2, "m/s"), "HKMaximumSpeed": quantity(10, "km/hr"), "HKSwimmingStrokeStyle": .number(2), "HKSWOLFScore": .number(40), "HKMetadataKeyWaterSalinity": .number(2), "HKIndoorWorkout": .bool(true), "HKSwimmingLocationType": .number(1), "custom": .string("keep"), "nativeObject": .object(["extra": .string("native")])])]
        let result = try workout(payload)
        XCTAssertEqual(try XCTUnwrap(result["activeEnergyBurned"]?.object?["qty"]?.number), 100, accuracy: 0.000001)
        XCTAssertEqual(try XCTUnwrap(result["totalEnergy"]?.object?["qty"]?.number), 120, accuracy: 0.000001)
        XCTAssertEqual(result["distance"], output(1.5, "km"))
        XCTAssertEqual(result["flightsClimbed"], output(8, "count"))
        XCTAssertEqual(result["totalSwimmingStrokeCount"], output(90, "count"))
        XCTAssertEqual(result["heartRate"], .object(["min": output(60, "bpm"), "avg": output(120, "bpm"), "max": output(180, "bpm")]))
        XCTAssertEqual(result["avgHeartRate"], output(120, "bpm")); XCTAssertEqual(result["maxHeartRate"], output(180, "bpm"))
        XCTAssertEqual(try XCTUnwrap(result["elevationUp"]?.object?["qty"]?.number), 30.48, accuracy: 0.000001)
        XCTAssertEqual(result["temperature"], output(20, "degC")); XCTAssertEqual(result["humidity"], output(65, "%"))
        XCTAssertEqual(result["intensity"], output(5, "MET")); XCTAssertEqual(result["lapLength"], output(50, "m"))
        XCTAssertEqual(try XCTUnwrap(result["avgSpeed"]?.object?["qty"]?.number), 7.2, accuracy: 0.000001)
        XCTAssertEqual(result["maxSpeed"], output(10, "kmph"))
        XCTAssertEqual(result["isIndoor"], .bool(true)); XCTAssertEqual(result["location"], .string("Pool"))
        XCTAssertEqual(result["strokeStyle"], .string("Freestyle")); XCTAssertEqual(result["salinity"], .string("Salt Water")); XCTAssertEqual(result["swolfScore"], .number(40))
        XCTAssertEqual(result["metadata"]?.object?["custom"], .string("keep")); XCTAssertNil(result["metadata"]?.object?["nativeObject"])
        for key in ["speed", "stepCadence", "swimCadence", "heartRateRecovery"] { XCTAssertNil(result[key]) }
        let v1 = try workout(payload, version: 1)
        XCTAssertEqual(Set(v1.keys), ["name", "start", "end", "activeEnergy", "totalEnergy", "distance"])
    }

    func testAllDocumentedWorkoutSeriesPreserveSourceAndConvertQuantity() throws {
        let rows: [(String, String, String, Double, String, Double)] = [
            ("ActiveEnergyBurned", "activeEnergy", "kJ", 4.184, "kcal", 1),
            ("BasalEnergyBurned", "basalEnergy", "kcal", 2, "kcal", 2),
            ("CyclingCadence", "cyclingCadence", "count/s", 2, "rpm", 120),
            ("DistanceCycling", "cyclingDistance", "m", 1000, "km", 1),
            ("CyclingPower", "cyclingPower", "W", 200, "W", 200),
            ("CyclingSpeed", "cyclingSpeed", "m/s", 5, "kmph", 18),
            ("DistanceSwimming", "swimDistance", "yd", 100, "m", 91.44),
            ("SwimmingStrokeCount", "swimStroke", "count", 30, "count", 30),
            ("DistanceWalkingRunning", "walkingAndRunningDistance", "mi", 1, "km", 1.609344),
            ("StepCount", "stepCount", "count", 50, "count", 50)]
        var metrics: [String: JSONValue] = [:]
        for (type, _, unit, value, _, _) in rows {
            metrics["HKQuantityTypeIdentifier" + type] = .object(["unit": .string(unit), "data": .array([.object(["start": .string("2026-01-01T00:00:00Z"), "sum": .number(value), "source": .string("Fixture Watch")])])])
        }
        let result = try workout(["activityType": .number(13), "durationSeconds": .number(540), "metrics": .object(metrics)])
        for (_, field, _, _, unit, value) in rows {
            let point = try XCTUnwrap(result[field]?.array?.first?.object, field)
            XCTAssertEqual(point["date"], .string("2026-01-01 00:00:00 +0000")); XCTAssertEqual(point["source"], .string("Fixture Watch"))
            XCTAssertEqual(point["units"], .string(unit)); XCTAssertEqual(try XCTUnwrap(point["qty"]?.number), value, accuracy: 0.000001)
        }
    }

    func testWorkoutActivityConfigurationFallbackRequiresAgreement() throws {
        func activity(_ lap: Double, _ location: Double) -> JSONValue { .object(["configuration": .object(["lapLength": quantity(lap, "m"), "locationType": .number(location), "swimmingLocationType": .number(1)])]) }
        var payload: [String: JSONValue] = ["activityType": .number(46), "durationSeconds": .number(500), "activities": .array([activity(50, 2), activity(50, 2)])]
        let same = try workout(payload)
        XCTAssertEqual(same["lapLength"], output(50, "m")); XCTAssertEqual(same["isIndoor"], .bool(true)); XCTAssertEqual(same["location"], .string("Pool"))
        payload["activities"] = .array([activity(50, 2), activity(25, 3)])
        let different = try workout(payload)
        XCTAssertNil(different["lapLength"]); XCTAssertNil(different["isIndoor"])
    }

    func testWorkoutRejectsUnknownActivityAndUnconvertibleUnits() throws {
        for activity in [0.0, 81, 2998, 2999, 9999, 37.5] { XCTAssertThrowsError(try workout(["activityType": .number(activity), "durationSeconds": .number(5)])) }
        XCTAssertThrowsError(try workout(["activityType": .number(37), "durationSeconds": .number(5), "totals": .object(["energyBurned": quantity(5, "m")])]))
        XCTAssertThrowsError(try workout(["activityType": .number(46), "durationSeconds": .number(5), "metadata": .object(["HKSwimmingStrokeStyle": .number(99)])]))
        let legacy = UploadBatch(task: .newTask(), records: [record(["activityType": .number(37), "durationSeconds": .number(5)], type: "HKWorkoutTypeIdentifier")])
        XCTAssertNoThrow(try BatchEncoder.encode(legacy, format: "hea.v1"))
    }
    func testWorkoutLocationEnumsUseExactSDKRawValues() throws {
        // HKWorkoutConfiguration.h: Unknown=1, Indoor=2, Outdoor=3 on iOS/watchOS.
        for (raw, indoor, location) in [(1.0, Optional<Bool>.none, Optional<String>.none), (2.0, true, "Indoor"), (3.0, false, "Outdoor")] {
            let payload: [String: JSONValue] = ["activityType": .number(37), "durationSeconds": .number(540), "activities": .array([.object(["configuration": .object(["locationType": .number(raw), "swimmingLocationType": .number(0)])])])]
            let result = try workout(payload)
            XCTAssertEqual(result["isIndoor"], indoor.map(JSONValue.bool), "raw=\(raw)")
            XCTAssertEqual(result["location"], location.map(JSONValue.string), "raw=\(raw)")
            XCTAssertNoThrow(try workout(payload, version: 1))
        }
        let invalid: [String: JSONValue] = ["activityType": .number(37), "durationSeconds": .number(540), "activities": .array([.object(["configuration": .object(["locationType": .number(0)])])])]
        XCTAssertThrowsError(try workout(invalid))
    }
    func testSwimmingMetadataEnumsUseTheirOwnSDKRawValues() throws {
        // HKMetadataEnums.h: swimming Unknown=0, Pool=1, OpenWater=2; stroke 0...6; salinity 1...2.
        for (raw, name) in [(0.0, Optional<String>.none), (1.0, "Pool"), (2.0, "Open Water")] {
            let result = try workout(["activityType": .number(46), "durationSeconds": .number(5), "metadata": .object(["HKSwimmingLocationType": .number(raw)])])
            XCTAssertEqual(result["location"], name.map(JSONValue.string))
        }
        for (raw, name) in ["Unknown", "Mixed", "Freestyle", "Backstroke", "Breaststroke", "Butterfly", "Kickboard"].enumerated() {
            let result = try workout(["activityType": .number(46), "durationSeconds": .number(5), "metadata": .object(["HKSwimmingStrokeStyle": .number(Double(raw))])])
            XCTAssertEqual(result["strokeStyle"], .string(name))
        }
        for (raw, name) in [(1.0, "Fresh Water"), (2.0, "Salt Water")] {
            let result = try workout(["activityType": .number(46), "durationSeconds": .number(5), "metadata": .object(["HKMetadataKeyWaterSalinity": .number(raw)])])
            XCTAssertEqual(result["salinity"], .string(name))
        }
        for (key, raw) in [("HKSwimmingLocationType", 3.0), ("HKSwimmingStrokeStyle", 7.0), ("HKMetadataKeyWaterSalinity", 0.0)] {
            XCTAssertThrowsError(try workout(["activityType": .number(46), "durationSeconds": .number(5), "metadata": .object([key: .number(raw)])]))
        }
    }

}
