import Foundation
import XCTest
@testable import HealthRelayCore

final class HEAFamilyTests: XCTestCase {
    func record(_ id: String, _ payload: [String: JSONValue] = [:], key: String = "sample") -> HealthRecord {
        HealthRecord(op: .upsert, typeIdentifier: id, recordId: key, start: "2026-01-01T00:00:00Z", end: "2026-01-01T00:01:00Z", source: .init(id: "fixture", name: "Fixture"), payload: payload)
    }
    func data(_ records: [HealthRecord], format: String = "hea.v2") throws -> [String: JSONValue] {
        let encoded = try BatchEncoder.encode(UploadBatch(task: .newTask(), records: records), format: format, timeZone: "UTC")
        guard case .object(let root) = try JSONDecoder().decode(JSONValue.self, from: encoded.body), case .object(let result) = root["data"] else { throw ConfigurationError("missing data") }
        return result
    }
    func testAutomaticMixedFamiliesAndVersionsDoNotDropRecords() throws {
        let records = [record("HKQuantityTypeIdentifierStepCount", ["value": .number(12), "unit": .string("count")]), record("HKCategoryTypeIdentifierHeadache", ["value": .number(2)]), record("HKCategoryTypeIdentifierMenstrualFlow", ["value": .number(3)])]
        for format in ["hea.v1", "hea.v2"] {
            let encoded = try data(records, format: format)
            XCTAssertEqual(Set(encoded.keys), ["metrics", "symptoms", "cycleTracking"])
        }
    }
    func testAllOfficialQuantityNamesAreExplicit() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "quantity-names", withExtension: "json", subdirectory: "Fixtures/hea"))
        let names = try JSONDecoder().decode([String: String].self, from: Data(contentsOf: url))
        XCTAssertEqual(names.count, 106)
        for (id, name) in names { XCTAssertEqual(HEAEncoder.metricNames[id], name, id) }
        XCTAssertEqual(HEAEncoder.metricNames["HKQuantityTypeIdentifierHeartRateVariabilityRMSSD"], "heart_rate_variability_rmssd")
    }
    func testHeartRateAndHRVConvertValuesWithUnits() throws {
        let result = try data([record("HKQuantityTypeIdentifierHeartRate", ["value": .number(2), "unit": .string("count/s")]), record("HKQuantityTypeIdentifierHeartRateVariabilitySDNN", ["value": .number(0.05), "unit": .string("s")])])
        guard case .array(let metrics) = result["metrics"], case .object(let heart) = metrics[0], case .array(let points) = heart["data"], case .object(let point) = points[0], case .object(let hrv) = metrics[1], case .array(let hrvPoints) = hrv["data"], case .object(let hrvPoint) = hrvPoints[0] else { return XCTFail("metrics") }
        XCTAssertEqual(heart["units"], .string("count/min")); XCTAssertEqual(point["Avg"], .number(120))
        XCTAssertEqual(hrv["units"], .string("ms")); XCTAssertEqual(hrvPoint["qty"], .number(50))
    }
    func testCategoryMappingsRespectDistinctEnumsAndContext() throws {
        let result = try data([record("HKCategoryTypeIdentifierAppetiteChanges", ["value": .number(3)]), record("HKCategoryTypeIdentifierMoodChanges", ["value": .number(0)]), record("HKCategoryTypeIdentifierMenstrualFlow", ["value": .number(5), "metadata": .object(["HKMenstrualCycleStart": .bool(true)])]), record("HKCategoryTypeIdentifierSexualActivity", ["value": .number(0), "metadata": .object(["HKSexualActivityProtectionUsed": .bool(true)])]), record("HKCategoryTypeIdentifierMindfulSession", ["value": .number(0)])])
        let text = String(decoding: try JSONEncoder().encode(result), as: UTF8.self)
        for expected in ["Increased", "Present", "None", "isCycleStart", "Protection Used", "mindful_minutes"] { XCTAssertTrue(text.contains(expected), expected) }
        XCTAssertThrowsError(try data([record("HKCategoryTypeIdentifierHeadache", ["value": .number(99)])]))
    }
    func testECGAndMoodUseDocumentedFamilyShapes() throws {
        let ecg = record("HKDataTypeIdentifierElectrocardiogram", ["classification": .number(1), "symptomsStatus": .number(2), "averageHeartRate": .object(["value": .number(1), "unit": .string("count/s")]), "samplingFrequency": .object(["value": .number(512), "unit": .string("Hz")]), "numberOfVoltageMeasurements": .number(1), "voltageMeasurements": .array([.object(["offsetMilliseconds": .number(125), "voltage": .number(0.001), "unit": .string("V")])])])
        let mood = record("HKDataTypeStateOfMind", ["kind": .number(2), "valence": .number(0.7), "valenceClassification": .number(6), "labels": .array([.number(17)]), "associations": .array([.number(13)]), "metadata": .object(["text": .string("keep"), "number": .number(4)])])
        let result = try data([ecg, mood])
        let text = String(decoding: try JSONEncoder().encode(result), as: UTF8.self)
        for expected in ["Sinus Rhythm", "2026-01-01 00:00:00.125 +0000", "daily_mood", "happy", "self_care", "pleasant", "keep"] { XCTAssertTrue(text.contains(expected), expected) }
        XCTAssertFalse(text.contains("severity")); XCTAssertFalse(text.contains("number\""))
        var incomplete = ecg; incomplete.payload?.removeValue(forKey: "samplingFrequency")
        XCTAssertThrowsError(try data([incomplete]))
        incomplete = ecg; incomplete.payload?["classification"] = .number(0)
        XCTAssertThrowsError(try data([incomplete]))
        incomplete = mood; incomplete.payload?["labels"] = .array([.number(99)])
        XCTAssertThrowsError(try data([incomplete]))
    }
    func testNotificationAssociatedQuantitiesExpandSeries() throws {
        var child = record("HKQuantityTypeIdentifierHeartRate", ["unit": .string("count/s"), "value": .number(2), "series": .array([.object(["start": .string("2026-01-01T00:00:00Z"), "end": .string("2026-01-01T00:00:02Z"), "value": .number(2)])])])
        let hr = try WorkoutExport.json(child)
        child.typeIdentifier = "HKQuantityTypeIdentifierHeartRateVariabilitySDNN"; child.payload = ["unit": .string("s"), "value": .number(0.05)]
        let notification = record("HKCategoryTypeIdentifierHighHeartRateEvent", ["value": .number(0), "metadata": .object(["HKHeartRateEventThreshold": .object(["value": .number(1.5), "unit": .string("count/s")])]), "associatedQuantities": .array([hr, try WorkoutExport.json(child)])])
        let result = try data([notification])
        let text = String(decoding: try JSONEncoder().encode(result), as: UTF8.self)
        for expected in ["threshold", "120", "90", "50", "duration", "heartRateVariation"] { XCTAssertTrue(text.contains(expected), expected) }
        XCTAssertFalse(text.contains("kind"))
    }
    func testUnsupportedSemanticsAndCSVNonMetricsFailClosed() throws {
        for id in ["HKMedicationDoseEventTypeIdentifierMedicationDoseEvent", "HKCategoryTypeIdentifierAppleStandHour", "HKCategoryTypeIdentifierHandwashingEvent", "HKCategoryTypeIdentifierToothbrushingEvent", "HKQuantityTypeIdentifierBloodPressureSystolic"] { XCTAssertThrowsError(try data([record(id, ["value": .number(0)])])) }
        let symptom = record("HKCategoryTypeIdentifierHeadache", ["value": .number(2)])
        let metric = record("HKQuantityTypeIdentifierStepCount", ["value": .number(1), "unit": .string("count")])
        XCTAssertThrowsError(try data([symptom], format: "hea.csv"))
        XCTAssertThrowsError(try data([metric, symptom], format: "hea.csv"))
        var task = AutomationConfig.newTask(); task.export.format = "hea.csv"
        XCTAssertFalse(task.executionCapabilityIssues.isEmpty)
    }
    func testEveryOfficialQuantityAcceptsEachConfiguredUnitWithoutRelabeling() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "quantity-names", withExtension: "json", subdirectory: "Fixtures/hea"))
        let names = try JSONDecoder().decode([String: String].self, from: Data(contentsOf: url))
        for (id, expectedName) in names {
            let metric = try XCTUnwrap(MetricCatalog.bundled.metric(id), id)
            XCTAssertFalse(metric.units.isEmpty, id)
            for unit in metric.units {
                let encoded = try data([record(id, ["value": .number(1), "unit": .string(unit)])])
                let output = try XCTUnwrap(encoded["metrics"]?.array?.first?.object, id)
                XCTAssertEqual(output["name"], .string(expectedName), id)
                let expectedUnit: String
                if id.contains("HeartRateVariability") { expectedUnit = "ms" }
                else if id == "HKQuantityTypeIdentifierHeartRate" { expectedUnit = "count/min" }
                else if ["HKQuantityTypeIdentifierRestingHeartRate", "HKQuantityTypeIdentifierWalkingHeartRateAverage", "HKQuantityTypeIdentifierHeartRateRecoveryOneMinute"].contains(id) { expectedUnit = "bpm" }
                else { expectedUnit = unit }
                XCTAssertEqual(output["units"], .string(expectedUnit), id)
            }
        }
    }
    func testAutomaticMixedEncodingIsStableAcrossInputOrder() throws {
        let records = [record("HKCategoryTypeIdentifierHeadache", ["value": .number(2)], key: "later"), record("HKQuantityTypeIdentifierStepCount", ["value": .number(1), "unit": .string("count")]), record("HKCategoryTypeIdentifierHeadache", ["value": .number(3)], key: "earlier")]
        for format in ["hea.v1", "hea.v2"] {
            XCTAssertEqual(try data(records, format: format), try data(records.reversed(), format: format))
        }
    }

    func testMindfulSessionRequiresTheSDKNotApplicableValue() throws {
        for format in ["hea.v1", "hea.v2"] {
            let result = try data([record("HKCategoryTypeIdentifierMindfulSession", ["value": .number(0)])], format: format)
            XCTAssertEqual(result["metrics"]?.array?.first?.object?["data"]?.array?.first?.object?["qty"], .number(1))
            for value in [JSONValue.number(99), .number(0.5), .number(-1), .number(1), .null] {
                XCTAssertThrowsError(try data([record("HKCategoryTypeIdentifierMindfulSession", ["value": value])], format: format))
            }
            XCTAssertThrowsError(try data([record("HKCategoryTypeIdentifierMindfulSession")], format: format))
        }
    }

}
