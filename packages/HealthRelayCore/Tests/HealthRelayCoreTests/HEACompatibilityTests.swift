import Foundation
import XCTest
@testable import HealthRelayCore

final class HEACompatibilityTests: XCTestCase {
    private let heartRate = "HKQuantityTypeIdentifierHeartRate"
    private let hrv = "HKQuantityTypeIdentifierHeartRateVariabilitySDNN"
    private let steps = "HKQuantityTypeIdentifierStepCount"
    private let sleep = "HKCategoryTypeIdentifierSleepAnalysis"

    private func record(_ type: String, payload: [String: JSONValue], start: String = "2026-10-12T03:00:00Z", id: String = "sample") -> HealthRecord {
        HealthRecord(op: .upsert, typeIdentifier: type, recordId: id, start: start,
                     end: "2026-10-12T04:00:00Z", source: RecordSource(id: "synthetic", name: "Synthetic Watch"), payload: payload)
    }

    private func metrics(_ records: [HealthRecord], timeZone: String = "Asia/Shanghai") throws -> [[String: Any]] {
        let batch = UploadBatch(task: .newTask(), records: records)
        let encoded = try HEAEncoder.encode(batch, timeZone: timeZone)
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded.body) as? [String: Any])
        let data = try XCTUnwrap(root["data"] as? [String: Any])
        return try XCTUnwrap(data["metrics"] as? [[String: Any]])
    }

    private func firstPoint(_ metric: [String: Any]) throws -> [String: Any] {
        try XCTUnwrap((metric["data"] as? [[String: Any]])?.first)
    }

    func testHeartRateAggregationUsesPublicStatisticFieldsAtBucketStart() throws {
        let metric = try XCTUnwrap(metrics([record(heartRate, payload: [
            "aggregation": .bool(true), "unit": .string("count/min"), "value": .number(72),
            "minimum": .number(65), "average": .number(72), "maximum": .number(85)
        ])]).first)
        XCTAssertEqual(metric["units"] as? String, "count/min")
        let point = try firstPoint(metric)
        XCTAssertEqual(point["date"] as? String, "2026-10-12 11:00:00 +0800")
        XCTAssertEqual(point["Min"] as? Double, 65)
        XCTAssertEqual(point["Avg"] as? Double, 72)
        XCTAssertEqual(point["Max"] as? Double, 85)
        XCTAssertNil(point["qty"])
        XCTAssertNil(point["recordId"])
    }

    func testHeartRateDoesNotInventUnrequestedAggregateExtrema() throws {
        let metric = try XCTUnwrap(metrics([record(heartRate, payload: [
            "aggregation": .bool(true), "unit": .string("count/min"), "value": .number(72), "average": .number(72)
        ])]).first)
        let point = try firstPoint(metric)
        XCTAssertEqual(point["Avg"] as? Double, 72)
        XCTAssertNil(point["Min"])
        XCTAssertNil(point["Max"])
    }

    func testRawHeartRateUsesOneMeasurementForMinAvgMax() throws {
        let metric = try XCTUnwrap(metrics([record(heartRate, payload: ["unit": .string("count/min"), "value": .number(68)])]).first)
        let point = try firstPoint(metric)
        XCTAssertEqual(point["Min"] as? Double, 68)
        XCTAssertEqual(point["Avg"] as? Double, 68)
        XCTAssertEqual(point["Max"] as? Double, 68)
        XCTAssertNil(point["qty"])
    }

    func testSleepAggregationUsesSleepDateAndHours() throws {
        let metric = try XCTUnwrap(metrics([record(sleep, payload: [
            "aggregation": .bool(true), "unit": .string("hr"), "sleepDate": .string("2026-10-12"),
            "totalSleep": .number(7.5), "asleep": .number(0.5), "core": .number(3.5),
            "deep": .number(1.5), "rem": .number(2), "awake": .number(0.25), "inBed": .number(8),
            "sleepStart": .string("2026-10-11T15:00:00Z"), "sleepEnd": .string("2026-10-11T22:30:00Z"),
            "inBedStart": .string("2026-10-11T14:45:00Z"), "inBedEnd": .string("2026-10-11T22:45:00Z")
        ])]).first)
        XCTAssertEqual(metric["units"] as? String, "hr")
        let point = try firstPoint(metric)
        XCTAssertEqual(point["date"] as? String, "2026-10-12")
        XCTAssertEqual(point["totalSleep"] as? Double, 7.5)
        XCTAssertEqual(point["asleep"] as? Double, 0.5)
        XCTAssertEqual(point["awake"] as? Double, 0.25)
        XCTAssertEqual(point["sleepStart"] as? String, "2026-10-11 23:00:00 +0800")
        XCTAssertEqual(point["inBedEnd"] as? String, "2026-10-12 06:45:00 +0800")
        XCTAssertNil(point["qty"])
    }

    func testRawHRVAndAggregatedCumulativeQuantitiesKeepQtyShape() throws {
        let items = try metrics([
            record(hrv, payload: ["unit": .string("ms"), "value": .number(45)]),
            record(steps, payload: ["aggregation": .bool(true), "unit": .string("count"), "value": .number(600), "sum": .number(600)])
        ])
        let hrvPoint = try firstPoint(XCTUnwrap(items.first { ($0["name"] as? String) == "heart_rate_variability" }))
        XCTAssertEqual(hrvPoint["qty"] as? Double, 45)
        XCTAssertNil(hrvPoint["Avg"])
        let stepPoint = try firstPoint(XCTUnwrap(items.first { ($0["name"] as? String) == "step_count" }))
        XCTAssertEqual(stepPoint["qty"] as? Double, 600)
    }

    func testDocumentedStandardQuantityMappings() throws {
        for (type, name, unit) in [
            ("BodyMass", "weight_&_body_mass", "kg"), ("BodyMassIndex", "body_mass_index", "count"),
            ("BodyTemperature", "body_temperature", "degC"), ("Height", "height", "m"),
            ("DietaryWater", "dietary_water", "mL")
        ] {
            let metric = try XCTUnwrap(metrics([record("HKQuantityTypeIdentifier" + type, payload: ["unit": .string(unit), "value": .number(1)])]).first)
            XCTAssertEqual(metric["name"] as? String, name)
        }
    }

    func testInvalidTimeZoneAndFractionalSleepCategoryAreRejected() throws {
        let quantity = record(steps, payload: ["unit": .string("count"), "value": .number(1)])
        XCTAssertThrowsError(try metrics([quantity], timeZone: "invalid/timezone"))
        XCTAssertThrowsError(try metrics([record(sleep, payload: ["value": .number(1.5)])]))
    }

    func testNativePercentFractionIsConvertedToDisplayPercent() throws {
        let metric = try XCTUnwrap(metrics([record("HKQuantityTypeIdentifierOxygenSaturation", payload: [
            "aggregation": .bool(true), "unit": .string("%"), "value": .number(0.97), "average": .number(0.97)
        ])]).first)
        XCTAssertEqual(metric["units"] as? String, "%")
        XCTAssertEqual(try firstPoint(metric)["qty"] as? Double, 97)
    }

    func testCSVUsesDeterministicSingleMultipartFileWithObservedColumns() throws {
        var batch = UploadBatch(task: .newTask(), records: [
            record(steps, payload: ["aggregation": .bool(true), "unit": .string("count"), "value": .number(120)]),
            record(heartRate, payload: ["aggregation": .bool(true), "unit": .string("count/min"), "value": .number(72),
                                       "minimum": .number(65), "average": .number(72), "maximum": .number(85)])
        ])
        batch.batchId = "synthetic-csv-batch"
        let encoded = try HEACSVEncoder.encode(batch, timeZone: "Asia/Shanghai")
        let repeated = try HEACSVEncoder.encode(batch, timeZone: "Asia/Shanghai")
        XCTAssertEqual(encoded.body, repeated.body)
        XCTAssertEqual(encoded.contentType, repeated.contentType)
        XCTAssertTrue(encoded.contentType.hasPrefix("multipart/form-data; boundary="))
        let boundary = String(encoded.contentType.dropFirst("multipart/form-data; boundary=".count))
        XCTAssertLessThanOrEqual(boundary.count, 70)
        let text = String(decoding: encoded.body, as: UTF8.self)
        XCTAssertTrue(text.contains("Content-Disposition: form-data; name=\"file\"; filename=\"HealthAutoExport.csv\"\r\n"))
        XCTAssertTrue(text.contains("日期/时间,心率 [最小值] (bpm),心率 [最大] (bpm),心率 [平均值] (bpm),步数 (步)\n"))
        XCTAssertTrue(text.contains("2026-10-12 11:00:00,65,85,72,120\n"))
        XCTAssertTrue(text.hasSuffix("--\(boundary)--\r\n"))
        XCTAssertEqual(text.components(separatedBy: "Content-Disposition: form-data;").count - 1, 1)
        batch.batchId = "different-csv-batch"
        XCTAssertNotEqual(try HEACSVEncoder.encode(batch, timeZone: "UTC").contentType, encoded.contentType)
    }

    func testCSVHasNoSourceColumnOrUntrustedSourceText() throws {
        for sourceName in ["=HYPERLINK(\"x\",\"y\")\r\nWatch", "+SUM(1,2)", "-1+2", "@SUM(1)", " \t=1", "\tWatch"] {
            var sample = record(hrv, payload: ["aggregation": .bool(true), "unit": .string("ms"), "value": .number(45)])
            sample.source?.name = sourceName
            let encoded = try HEACSVEncoder.encode(UploadBatch(task: .newTask(), records: [sample]), timeZone: "UTC")
            let text = String(decoding: encoded.body, as: UTF8.self)
            XCTAssertFalse(text.contains(sourceName))
            XCTAssertFalse(text.contains("Source"))
            XCTAssertFalse(text.contains("\"payload\""))
        }
    }

    func testCSVSleepSummariesUseSevenDurationColumnsWithoutAncillaryTimestamps() throws {
        let sample = record(sleep, payload: ["aggregation": .bool(true), "unit": .string("hr"),
                                           "sleepDate": .string("2026-10-12"), "totalSleep": .number(7.5), "core": .number(4),
                                           "sleepStart": .string("2026-10-11T15:00:00Z")])
        let encoded = try HEACSVEncoder.encode(UploadBatch(task: .newTask(), records: [sample]), timeZone: "UTC")
        let text = String(decoding: encoded.body, as: UTF8.self)
        XCTAssertTrue(text.contains("日期/时间,睡眠分析 [Total] (小时),睡眠分析 [睡眠时长] (小时),睡眠分析 [在床上] (小时),睡眠分析 [核心] (小时),睡眠分析 [深度] (小时),睡眠分析 [快速动眼期] (小时),睡眠分析 [清醒] (小时)\n"))
        XCTAssertTrue(text.contains("2026-10-12 00:00:00,7.5,,,4,,,\n"))
        XCTAssertFalse(text.contains("2026-10-11 15:00:00"))
        XCTAssertFalse(text.contains("Source"))
    }

    func testRequestMetadataIsStableAndHeaderSafe() {
        var task = AutomationConfig(id: UUID(uuidString: "11111111-2222-3333-4444-555555555555")!)
        task.name = "心率\r\nX-Fake: yes%"
        task.export.mode = .aggregate; task.export.grouping = .hours
        let headers = HEARequestMetadata.headers(task: task, batchID: "synthetic-session")
        XCTAssertEqual(headers["automation-name"], "%E5%BF%83%E7%8E%87%0D%0AX-Fake: yes%25")
        XCTAssertEqual(headers["automation-id"], task.id.uuidString.lowercased())
        XCTAssertEqual(headers["automation-aggregation"], "hours")
        XCTAssertEqual(headers["automation-period"], "lastsync")
        XCTAssertEqual(headers["session-id"], "synthetic-session")
        XCTAssertEqual(headers, HEARequestMetadata.headers(task: task, batchID: "synthetic-session"))
        XCTAssertTrue(headers.values.allSatisfy { $0.utf8.allSatisfy { (32...126).contains($0) } })
    }

    func testRequestPeriodMappingDoesNotMislabelRollingDaysAsPreviousSevenDays() throws {
        var task = AutomationConfig.newTask()
        for (mode, days, period) in [("incremental", 7, "lastsync"), ("today", 7, "today"),
                                     ("yesterday", 7, "yesterday"), ("defaultRange", 7, "none"),
                                     ("previousDays", 7, "previous7days"), ("previousDays", 3, "custom"),
                                     ("pastDays", 7, "custom"), ("custom", 7, "custom")] {
            task.range.mode = try XCTUnwrap(DateRange.Mode(rawValue: mode))
            task.range.days = days
            XCTAssertEqual(HEARequestMetadata.headers(task: task, batchID: "session")["automation-period"], period)
        }
    }
}
