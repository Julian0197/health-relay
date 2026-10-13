import Foundation
import XCTest
@testable import HealthRelayCore

final class HEACSVObservedTests: XCTestCase {
    private let prefix = "HKQuantityTypeIdentifier"
    private let sleep = "HKCategoryTypeIdentifierSleepAnalysis"
    private func record(_ suffix: String, _ unit: String, _ value: Double, start: String = "2026-02-01T16:00:00Z", statistics: [String: JSONValue] = [:]) -> HealthRecord {
        var payload: [String: JSONValue] = ["aggregation": .bool(true), "unit": .string(unit), "value": .number(value)]
        payload.merge(statistics) { _, value in value }
        return HealthRecord(op: .upsert, typeIdentifier: prefix + suffix, recordId: suffix + start, start: start,
                            source: RecordSource(id: "synthetic", name: "Synthetic Watch"), payload: payload)
    }
    private func csv(_ records: [HealthRecord], timeZone: String = "Asia/Shanghai") throws -> String {
        try Self.table(HEACSVEncoder.encode(UploadBatch(task: .newTask(), records: records), timeZone: timeZone))
    }
    static func table(_ encoded: EncodedBatch) throws -> String {
        let body = String(decoding: encoded.body, as: UTF8.self)
        XCTAssertEqual(body.components(separatedBy: "Content-Disposition:").count - 1, 1, "Exactly one multipart file")
        let start = try XCTUnwrap(body.range(of: "\r\n\r\n")).upperBound
        let contents = String(body[start...])
        return try XCTUnwrap(contents.components(separatedBy: "\r\n--").first)
    }
    private func fixture(_ file: String) throws -> Data {
        let folder = try XCTUnwrap(Bundle.module.url(forResource: "Fixtures", withExtension: nil))
        return try Data(contentsOf: folder.appendingPathComponent("hea/" + file))
    }
    private struct Columns: Decodable {
        var observedHeaders: [String]
        var quantities: [Quantity]
        struct Quantity: Decodable { var typeIdentifier: String; var header: String; var unit: String; var order: Int }
    }
    func testSyntheticWideCSVExactlyMatchesObservedHeaderOrderDatesUnitsAndBlanks() throws {
        var later = record("StepCount", "count", 600, start: "2026-02-02T16:00:00Z")
        later.recordId = "later"
        let asleep = HealthRecord(op: .upsert, typeIdentifier: sleep, recordId: "sleep", start: "2026-02-01T10:00:00Z", payload: [
            "aggregation": .bool(true), "unit": .string("hr"), "sleepDate": .string("2026-02-02"),
            "totalSleep": .number(7.5), "asleep": .number(7.5), "inBed": .number(8), "core": .number(4),
            "deep": .number(1.5), "rem": .number(2), "awake": .number(0.5),
            "sleepStart": .string("2026-02-01T16:00:00Z"), "sleepEnd": .string("2026-02-01T23:30:00Z")
        ])
        let records = [later, asleep,
            record("HeartRate", "count/s", 1.25, statistics: ["minimum": .number(1), "maximum": .number(1.5), "average": .number(1.25)]),
            record("StepCount", "count", 300), record("BodyFatPercentage", "%", 0.25),
            record("HeartRateVariabilitySDNN", "s", 0.05), record("WalkingStepLength", "m", 0.8),
            record("RunningStrideLength", "cm", 150), record("DistanceWalkingRunning", "m", 2000),
            record("ActiveEnergyBurned", "kcal", 100), record("OxygenSaturation", "%", 0.98),
            record("BloodGlucose", "mg/dL", 90.07794000002704)
        ]
        let expected = String(decoding: try fixture("observed-health-metrics.csv"), as: UTF8.self)
        XCTAssertEqual(try csv(records), expected)
        XCTAssertEqual(try csv(records.reversed()), expected)
        XCTAssertFalse(expected.contains("\r"))
        XCTAssertFalse(expected.hasPrefix("\u{feff}"))
    }
    func testAll106QuantityColumnsMatchCapturedHeadersAndNativeUnitsConvert() throws {
        let fixture = try JSONDecoder().decode(Columns.self, from: fixture("observed-csv-columns.json"))
        XCTAssertEqual(fixture.observedHeaders.count, 126)
        XCTAssertEqual(fixture.quantities.count, 106)
        XCTAssertEqual(Set(fixture.quantities.map(\.typeIdentifier)), Set(HEAMetricCatalog.quantityNames.keys).subtracting([prefix + "HeartRateVariabilityRMSSD"]))
        let scales: [[String: Double]] = [
            ["s": 1, "ms": 0.001, "min": 60, "hr": 3600],
            ["m": 1, "km": 1000, "mi": 1609.344, "cm": 0.01],
            ["m/s": 1, "km/hr": 1 / 3.6, "mi/hr": 0.44704],
            ["count/min": 1, "count/s": 60, "bpm": 1],
            ["kcal": 4.184, "kJ": 1], ["g": 1, "mg": 0.001, "mcg": 0.000001, "kg": 1000, "lb": 453.59237],
            ["L": 1000, "mL": 1], ["S": 1000000, "mcS": 1], ["mg/dL": 1, "mmol/L": 18.015588000005408]
        ]
        for column in fixture.quantities {
            XCTAssertEqual(column.header, fixture.observedHeaders[column.order])
            let descriptor = try XCTUnwrap(MetricCatalog.bundled.metric(column.typeIdentifier))
            for unit in descriptor.units {
                var sample = record(String(column.typeIdentifier.dropFirst(prefix.count)), unit, 2)
                if column.typeIdentifier == prefix + "HeartRate" { sample.payload?["average"] = .number(2) }
                let rows = try csv([sample]).components(separatedBy: "\n").map { $0.components(separatedBy: ",") }
                let heart = column.typeIdentifier == prefix + "HeartRate"
                XCTAssertEqual(rows[0], ["日期/时间"] + (heart ? Array(fixture.observedHeaders[23...25]) : [column.header]), column.typeIdentifier)
                var expected = 2.0
                if unit == "%" { expected = 200 }
                else if unit == "degF" { expected = (2 - 32) * 5 / 9 }
                else if unit != column.unit {
                    let dimension = try XCTUnwrap(scales.first { $0[unit] != nil && $0[column.unit] != nil }, "\(unit) -> \(column.unit)")
                    expected = 2 * dimension[unit]! / dimension[column.unit]!
                }
                let value = try XCTUnwrap(Double(rows[1][heart ? 3 : 1]), "\(column.typeIdentifier) / \(unit)")
                XCTAssertEqual(value, expected, accuracy: max(0.0000001, abs(expected) * 1e-12), "\(column.typeIdentifier) / \(unit)")
            }
        }
    }
    func testSingleSelectedStatisticsUseTheirOwnValueAndMultipleStatisticsReject() throws {
        for (statistic, value) in [("minimum", 2.0), ("maximum", 9), ("average", 5), ("sum", 20)] {
            let cumulative = statistic == "sum"
            let sample = record(cumulative ? "StepCount" : "BodyMass", cumulative ? "count" : "kg", value, statistics: [statistic: .number(value)])
            let header = cumulative ? "步数 (步)" : "体重 (千克)"
            XCTAssertEqual(try csv([sample]), "日期/时间,\(header)\n2026-02-02 00:00:00,\(Int(value))\n")
        }
        let multiple = record("BodyMass", "kg", 70, statistics: ["average": .number(70), "minimum": .number(60)])
        XCTAssertThrowsError(try csv([multiple])) { XCTAssertTrue($0.localizedDescription.contains("统计")) }
        let summedHeart = record("HeartRate", "count/min", 200, statistics: ["sum": .number(200), "average": .number(70)])
        XCTAssertThrowsError(try csv([summedHeart]))
        let inconsistent = record("BodyMass", "kg", 70, statistics: ["minimum": .number(60)])
        XCTAssertThrowsError(try csv([inconsistent]))
    }
    func testDuplicateMetricBucketCannotOverwriteEvenAcrossSources() throws {
        let first = record("StepCount", "count", 300)
        var second = first; second.recordId = "second"; second.source = RecordSource(id: "other", name: "Other Watch")
        XCTAssertThrowsError(try csv([first, second])) { XCTAssertTrue($0.localizedDescription.contains("来源")) }
        XCTAssertThrowsError(try csv([first, first]))
        var distinct = record("HeartRate", "count/min", 70, statistics: ["average": .number(70)])
        distinct.source = second.source
        XCTAssertNoThrow(try csv([first, distinct]))
    }
    func testRawDeletionUnmappedExtensionNonmetricAndMalformedCellsReject() throws {
        var raw = record("StepCount", "count", 1); raw.payload?["aggregation"] = nil
        var deleted = raw; deleted.op = .delete; deleted.payload = nil
        var invalid = record("BodyMass", "kg", 1); invalid.payload?["value"] = .number(.infinity)
        var unsupported = record("StepCount", "count", 1); unsupported.payload?["extra"] = .number(1)
        for sample in [raw, deleted, invalid, unsupported, record("HeartRateVariabilityRMSSD", "ms", 50), record("StepCount", "kg", 1)] {
            XCTAssertThrowsError(try csv([sample]), sample.typeIdentifier)
        }
        for type in ["HKWorkoutType", "HKCategoryTypeIdentifierHeadache", "HKCategoryTypeIdentifierAppleStandHour", "HKCategoryTypeIdentifierHandwashingEvent", "HKCategoryTypeIdentifierToothbrushingEvent", "HKCategoryTypeIdentifierMindfulSession", "HKCategoryTypeIdentifierSexualActivity", "HKCorrelationTypeIdentifierBloodPressure"] {
            var sample = raw; sample.typeIdentifier = type; sample.payload?["aggregation"] = .bool(true)
            XCTAssertThrowsError(try csv([sample]), type)
        }
        XCTAssertThrowsError(try csv([record("StepCount", "count", 1)], timeZone: "bad/zone"))
    }
    func testSleepDateUsesLocalMidnightAndRequiresRealCalendarDate() throws {
        var asleep = record("StepCount", "hr", 1)
        asleep.typeIdentifier = sleep
        asleep.payload = ["aggregation": .bool(true), "unit": .string("hr"), "sleepDate": .string("2026-03-08"), "totalSleep": .number(1)]
        let steps = record("StepCount", "count", 10, start: "2026-03-08T08:00:00Z")
        let text = try csv([asleep, steps], timeZone: "America/Los_Angeles")
        XCTAssertEqual(text.split(separator: "\n").count, 2)
        XCTAssertTrue(text.contains("2026-03-08 00:00:00,10,1,,,,,,\n"))
        asleep.payload?["sleepDate"] = .string("2026-02-30")
        XCTAssertThrowsError(try csv([asleep]))
    }
    func testSelectedEmptyColumnsKeepFullCaptureOrderAndDoNotEnterNativeWireSchema() throws {
        let specification = try JSONDecoder().decode(Columns.self, from: fixture("observed-csv-columns.json"))
        let selected = specification.quantities.map(\.typeIdentifier) + [sleep]
        let empty = UploadBatch(task: .newTask(), records: [])
        let encoded = try BatchEncoder.encode(empty, format: "hea.csv", selectedTypeIdentifiers: selected.reversed())
        let included = Set(specification.quantities.map(\.order)).union([24, 25]).union(62...68)
        let expected = specification.observedHeaders.enumerated().filter { $0.offset == 0 || included.contains($0.offset) }.map(\.element).joined(separator: ",") + "\n"
        XCTAssertEqual(try Self.table(encoded), expected)
        XCTAssertThrowsError(try BatchEncoder.encode(empty, format: "hea.csv", selectedTypeIdentifiers: [prefix + "HeartRateVariabilityRMSSD"]))
        XCTAssertThrowsError(try BatchEncoder.encode(empty, format: "hea.csv", selectedTypeIdentifiers: ["HKWorkoutType"]))
        let original = try BatchEncoder.encode(empty)
        let native = try BatchEncoder.encode(empty, selectedTypeIdentifiers: selected)
        XCTAssertEqual(original.body, native.body)
        XCTAssertFalse(String(decoding: native.body, as: UTF8.self).contains("selectedTypeIdentifiers"))
    }
    func testRequestedHeartStatisticsRemainSparseAndConflictingPreferredValueRejects() throws {
        let minimum = record("HeartRate", "count/min", 60, statistics: ["minimum": .number(60)])
        XCTAssertTrue(try csv([minimum]).contains("2026-02-02 00:00:00,60,,\n"))
        var inconsistent = record("HeartRate", "count/min", 60, statistics: ["average": .number(70)])
        XCTAssertThrowsError(try csv([inconsistent]))
        inconsistent.payload?["value"] = .number(.infinity)
        XCTAssertThrowsError(try csv([inconsistent]))
    }
    func testZeroCellsAndSleepPrecisionArePreservedAndTextEscapingRemainsSafe() throws {
        XCTAssertTrue(try csv([record("StepCount", "count", 0)]).contains(",0\n"))
        var asleep = record("StepCount", "hr", 1); asleep.typeIdentifier = sleep
        asleep.payload = ["aggregation": .bool(true), "unit": .string("hr"), "sleepDate": .string("2026-02-02"), "totalSleep": .number(1.2345678901234567)]
        XCTAssertTrue(try csv([asleep]).contains(",1.2345678901234567,,,,,,\n"))
        XCTAssertEqual(HEACSVEncoder.quote("a,\"b\"\n"), "\"a,\"\"b\"\"\n\"")
        for text in ["=1+1", "+SUM(1,2)", "-1+2", "@SUM(1)", " \t=1", "\tWatch", "\rWatch", "\nWatch"] {
            let encoded = HEACSVEncoder.quote(text)
            XCTAssertTrue(encoded.hasPrefix("'") || encoded.hasPrefix("\"'"))
        }
        XCTAssertEqual(HEACSVEncoder.quote("日期/时间"), "日期/时间")
    }

}
