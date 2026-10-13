import XCTest
import HealthKit
import HealthRelayCore
#if os(watchOS)
@testable import HealthRelayWatch
#else
@testable import HealthRelay
#endif

@MainActor final class SpecializedHealthReaderTests: XCTestCase {
    let start = Date(timeIntervalSince1970: 1_800_000_000)

    func testSpecialTypesUseTheirActualRuntimeIdentifiers() throws {
        let reader = HealthKitReader()
        XCTAssertEqual(try reader.sampleType("HKDataTypeIdentifierElectrocardiogram"), HKObjectType.electrocardiogramType())
        XCTAssertEqual(try reader.sampleType("HKDataTypeStateOfMind"), HKObjectType.stateOfMindType())
        if #available(iOS 26, watchOS 26, *) {
            XCTAssertEqual(try reader.sampleType("HKMedicationDoseEventTypeIdentifierMedicationDoseEvent"), HKObjectType.medicationDoseEventType())
        }
    }

    func testStateOfMindKeepsNativeValuesAndSDKClassification() throws {
        let sample = HKStateOfMind(date: start, kind: .dailyMood, valence: -0.42, labels: [.sad, .worried], associations: [.work, .health], metadata: ["origin": "fixture"])
        let record = try HealthKitReader().record(sample, unit: nil)
        XCTAssertEqual(record.recordId, sample.uuid.uuidString.lowercased())
        XCTAssertEqual(record.start, HealthTimestamp.string(start))
        XCTAssertEqual(record.source?.id, sample.sourceRevision.source.bundleIdentifier)
        XCTAssertEqual(record.payload?["kind"], .number(Double(sample.kind.rawValue)))
        XCTAssertEqual(record.payload?["valence"], .number(-0.42))
        XCTAssertEqual(record.payload?["valenceClassification"], .number(Double(sample.valenceClassification.rawValue)))
        XCTAssertEqual(record.payload?["labels"], .array(sample.labels.map { .number(Double($0.rawValue)) }))
        XCTAssertEqual(record.payload?["associations"], .array(sample.associations.map { .number(Double($0.rawValue)) }))
        XCTAssertEqual(record.payload?["metadata"], .object(["origin": .string("fixture")]))
    }

    func testNotificationPermissionsOnlyRequestTheSeriesTheyRead() throws {
        var task = AutomationConfig(); task.data.selections = [.init(typeIdentifier: "HKCategoryTypeIdentifierHighHeartRateEvent")]
        XCTAssertEqual(try HealthKitReader().authorizationTypes(task), [HKCategoryType(.highHeartRateEvent), HKQuantityType(.heartRate), HKQuantityType(.heartRateVariabilitySDNN)])
        task.data.selections = [.init(typeIdentifier: "HKCategoryTypeIdentifierMindfulSession")]
        XCTAssertEqual(try HealthKitReader().authorizationTypes(task), [HKCategoryType(.mindfulSession)])
    }

    func testThresholdConvertsToCountPerMinute() throws {
        let metadata = try WorkoutReader.metadata([HKMetadataKeyHeartRateEventThreshold: HKQuantity(unit: HKUnit.count().unitDivided(by: .second()), doubleValue: 2)])
        XCTAssertEqual(metadata["HKHeartRateEventThreshold"], .object(["value": .number(120), "unit": .string("count/min")]))
    }

    func testMedicationPermissionIncludesAnnotatedType() throws {
        if #available(iOS 26, watchOS 26, *) {
            var task = AutomationConfig(); task.data.selections = [.init(typeIdentifier: "HKMedicationDoseEventTypeIdentifierMedicationDoseEvent")]
            XCTAssertEqual(try HealthKitReader().authorizationTypes(task), [HKObjectType.medicationDoseEventType(), HKObjectType.userAnnotatedMedicationType()])
        }
    }
}

extension SpecializedHealthReaderTests {
    func testECGKeepsUnknownEnumsNullsAndMillisecondVoltageOffsets() async throws {
        let value = try await SpecializedHealthReader.ecgPayload(classification: 701, symptomsStatus: 99, averageHeartRate: nil, samplingFrequency: nil, count: 2, measurements: {
            [ECGMeasurement(offsetSeconds: 0, voltage: HKQuantity(unit: .voltUnit(with: .milli), doubleValue: 1.25)), ECGMeasurement(offsetSeconds: 0.0025, voltage: HKQuantity(unit: .volt(), doubleValue: -0.002))]
        })
        XCTAssertEqual(value["classification"], .number(701)); XCTAssertEqual(value["symptomsStatus"], .number(99))
        XCTAssertNil(value["averageHeartRate"]); XCTAssertNil(value["samplingFrequency"]); XCTAssertNil(value["severity"])
        XCTAssertEqual(value["numberOfVoltageMeasurements"], .number(2))
        XCTAssertEqual(value["voltageMeasurements"], .array([.object(["offsetMilliseconds": .number(0), "voltage": .number(0.00125), "unit": .string("V")]), .object(["offsetMilliseconds": .number(2.5), "voltage": .number(-0.002), "unit": .string("V")])]))
    }
    func testECGConvertsPresentRateAndFrequency() async throws {
        let value = try await SpecializedHealthReader.ecgPayload(classification: 1, symptomsStatus: 2, averageHeartRate: HKQuantity(unit: HKUnit.count().unitDivided(by: .second()), doubleValue: 1.2), samplingFrequency: HKQuantity(unit: .hertz(), doubleValue: 256), count: 0, measurements: { [] })
        XCTAssertEqual(value["averageHeartRate"], .object(["value": .number(72), "unit": .string("count/min")]))
        XCTAssertEqual(value["samplingFrequency"], .object(["value": .number(256), "unit": .string("Hz")]))
    }
    func testECGRejectsIncompleteAndMissingLeadInsteadOfReturningPartialPayload() async {
        for values in [[], [ECGMeasurement(offsetSeconds: 0, voltage: nil)]] {
            do { _ = try await SpecializedHealthReader.ecgPayload(classification: 0, symptomsStatus: 0, averageHeartRate: nil, samplingFrequency: nil, count: 1, measurements: { values }); XCTFail("Incomplete ECG must fail") } catch {}
        }
    }
    func testECGPropagatesQueryErrorAndCancellation() async {
        do { _ = try await SpecializedHealthReader.ecgPayload(classification: 0, symptomsStatus: 0, averageHeartRate: nil, samplingFrequency: nil, count: 1, measurements: { throw ConfigurationError("locked") }); XCTFail("Expected error") } catch { XCTAssertEqual(error as? ConfigurationError, ConfigurationError("locked")) }
        do { _ = try await SpecializedHealthReader.ecgPayload(classification: 0, symptomsStatus: 0, averageHeartRate: nil, samplingFrequency: nil, count: 1, measurements: { throw CancellationError() }); XCTFail("Expected cancellation") } catch { XCTAssertTrue(error is CancellationError) }
    }
    func testMedicationAllStatusesPreserveActualAndScheduledDoseSeparately() throws {
        let identifier: JSONValue = .object(["domain": .string("medication"), "archive": .string("fixture-only")])
        let annotation: [String: JSONValue] = ["displayText": .string("Example"), "generalForm": .string("tablet"), "nickname": .string("Morning"), "isArchived": .bool(false), "hasSchedule": .bool(true), "relatedCodings": .array([.object(["code": .string("123"), "system": .string("test"), "version": .null])])]
        for status in [1, 2, 3, 4, 5, 6, 701] {
            let value = try SpecializedHealthReader.medicationPayload(logStatus: status, scheduleType: 1, scheduledDate: start, doseQuantity: 0.5, scheduledDoseQuantity: 2, unit: "count", conceptIdentifier: identifier, annotation: annotation)
            XCTAssertEqual(value["logStatus"], .number(Double(status)))
            XCTAssertEqual(value["scheduleType"], .number(1)); XCTAssertEqual(value["scheduledDate"], .string(HealthTimestamp.string(start)))
            XCTAssertEqual(value["doseQuantity"], .number(0.5)); XCTAssertEqual(value["scheduledDoseQuantity"], .number(2))
            XCTAssertEqual(value["unit"], .string("count")); XCTAssertEqual(value["medicationConceptIdentifier"], identifier)
            XCTAssertEqual(value["medication"], .object(annotation)); XCTAssertNil(value["courseStart"]); XCTAssertNil(value["courseEnd"])
        }
        let missing = try SpecializedHealthReader.medicationPayload(logStatus: 6, scheduleType: 2, scheduledDate: nil, doseQuantity: nil, scheduledDoseQuantity: 1, unit: "mL", conceptIdentifier: identifier, annotation: nil)
        XCTAssertNil(missing["doseQuantity"]); XCTAssertNil(missing["scheduledDate"]); XCTAssertNil(missing["medication"])
        XCTAssertEqual(missing["annotationStatus"], .string("notReturned")); XCTAssertEqual(missing["unit"], .string("mL"))
    }
    func testNotificationPageUsesOverlapPolicyAndExpandsHRVSeries() async throws {
        let sample = HKCategorySample(type: HKCategoryType(.irregularHeartRhythmEvent), value: 0, start: start, end: start.addingTimeInterval(60))
        let quantity = HKQuantitySample(type: HKQuantityType(.heartRateVariabilitySDNN), quantity: HKQuantity(unit: .second(), doubleValue: 0.06), start: start, end: start.addingTimeInterval(10))
        var reads = 0
        let queries = WorkoutQueries(routes: { _ in XCTFail("No routes"); return [] }, quantities: { predicates in
            reads += 1
            XCTAssertEqual(Set(predicates.map(\.sampleType)), [HKQuantityType(.heartRate), HKQuantityType(.heartRateVariabilitySDNN)])
            for predicate in predicates { XCTAssertEqual(predicate.nsPredicate, HKQuery.predicateForSamples(withStart: sample.startDate, end: sample.endDate, options: [])) }
            return [WorkoutQuantityData(sample: quantity, count: 2, series: {
                [WorkoutQuantityPoint(quantity: HKQuantity(unit: .second(), doubleValue: 0.05), interval: DateInterval(start: self.start, duration: 1)), WorkoutQuantityPoint(quantity: HKQuantity(unit: .second(), doubleValue: 0.07), interval: DateInterval(start: self.start.addingTimeInterval(2), duration: 1))]
            })]
        })
        let selection = MetricSelection(typeIdentifier: sample.sampleType.identifier)
        let page = try await HealthKitReader(workoutQueries: queries).makePage(samples: [sample], deletedIDs: [], anchor: Data([7]), hasMore: false, end: nil, task: AutomationConfig(), selection: selection)
        XCTAssertEqual(reads, 1); XCTAssertEqual(page.anchor, Data([7]))
        XCTAssertEqual(page.records[0].payload?["associationPolicy"], .string("overlap-event-interval-v1"))
        guard case .array(let associated)? = page.records[0].payload?["associatedQuantities"], case .object(let child) = associated.first, case .object(let payload)? = child["payload"], case .array(let series)? = payload["series"] else { return XCTFail("Missing native associated series") }
        XCTAssertEqual(child["recordId"], .string(quantity.uuid.uuidString.lowercased()))
        XCTAssertEqual(payload["unit"], .string("ms")); XCTAssertEqual(series.count, 2)
        XCTAssertEqual(series.first, .object(["start": .string(HealthTimestamp.string(start)), "end": .string(HealthTimestamp.string(start.addingTimeInterval(1))), "value": .number(50)]))
    }
    func testNotificationFailureCannotPublishPageOrAnchor() async throws {
        let sample = HKCategorySample(type: HKCategoryType(.highHeartRateEvent), value: 0, start: start, end: start.addingTimeInterval(60))
        let queries = WorkoutQueries(routes: { _ in [] }, quantities: { _ in throw ConfigurationError("locked") })
        do { _ = try await HealthKitReader(workoutQueries: queries).makePage(samples: [sample], deletedIDs: [UUID()], anchor: Data([8]), hasMore: false, end: nil, task: AutomationConfig(), selection: MetricSelection(typeIdentifier: sample.sampleType.identifier)); XCTFail("Page must fail before publishing anchor") } catch { XCTAssertEqual(error as? ConfigurationError, ConfigurationError("locked")) }
    }
}

extension SpecializedHealthReaderTests {
    func testNotificationChildSourceFiltersSkipSeriesRead() async throws {
        let sample = HKCategorySample(type: HKCategoryType(.lowHeartRateEvent), value: 0, start: start, end: start.addingTimeInterval(60))
        let quantity = HKQuantitySample(type: HKQuantityType(.heartRate), quantity: HKQuantity(unit: HKUnit.count().unitDivided(by: .minute()), doubleValue: 40), start: start, end: start.addingTimeInterval(10))
        let source = quantity.sourceRevision.source.bundleIdentifier
        let queries = WorkoutQueries(routes: { _ in [] }, quantities: { _ in
            [WorkoutQuantityData(sample: quantity, count: 2, series: { XCTFail("Filtered child must not query details"); return [] })]
        })
        let reader = HealthKitReader(workoutQueries: queries)
        for useExclusion in [true, false] {
            var task = AutomationConfig()
            let selection = MetricSelection(typeIdentifier: sample.sampleType.identifier, sources: useExclusion ? [] : ["different-source"])
            if useExclusion { task.data.excludedSources = [source] }
            let result = try await SpecializedHealthReader.notification(sample, record: reader.record(sample, unit: nil), reader: reader, task: task, selection: selection)
            XCTAssertEqual(result.payload?["associatedQuantities"], .array([]))
        }
    }
    func testNotificationPartialSeriesAndCancellationNeverReturnPage() async throws {
        let sample = HKCategorySample(type: HKCategoryType(.highHeartRateEvent), value: 0, start: start, end: start.addingTimeInterval(60))
        let quantity = HKQuantitySample(type: HKQuantityType(.heartRate), quantity: HKQuantity(unit: HKUnit.count().unitDivided(by: .minute()), doubleValue: 130), start: start, end: start.addingTimeInterval(10))
        for cancel in [true, false] {
            let queries = WorkoutQueries(routes: { _ in [] }, quantities: { _ in
                [WorkoutQuantityData(sample: quantity, count: 2, series: { if cancel { throw CancellationError() }; return [] })]
            })
            do {
                _ = try await HealthKitReader(workoutQueries: queries).makePage(samples: [sample], deletedIDs: [UUID()], anchor: Data([9]), hasMore: true, end: nil, task: AutomationConfig(), selection: MetricSelection(typeIdentifier: sample.sampleType.identifier))
                XCTFail("A partial child must prevent page publication")
            } catch { if cancel { XCTAssertTrue(error is CancellationError) } else { XCTAssertTrue(error is ConfigurationError) } }
        }
    }
    func testPageSourceFilterSkipsNotificationQueriesAndKeepsDeletion() async throws {
        let sample = HKCategorySample(type: HKCategoryType(.highHeartRateEvent), value: 0, start: start, end: start.addingTimeInterval(60))
        let queries = WorkoutQueries(routes: { _ in [] }, quantities: { _ in XCTFail("Filtered parent must not query children"); return [] })
        var task = AutomationConfig(); task.data.excludedSources = [sample.sourceRevision.source.bundleIdentifier]
        let deletedID = UUID()
        let page = try await HealthKitReader(workoutQueries: queries).makePage(samples: [sample], deletedIDs: [deletedID], anchor: Data([9]), hasMore: false, end: nil, task: task, selection: MetricSelection(typeIdentifier: sample.sampleType.identifier))
        XCTAssertEqual(page.records.map(\.recordId), [deletedID.uuidString.lowercased()])
        XCTAssertEqual(page.records[0].op, .delete); XCTAssertEqual(page.anchor, Data([9]))
    }
    func testAlreadyCancelledECGDoesNotStartTheQuery() async {
        let operation = Task { @MainActor in
            withUnsafeCurrentTask { $0?.cancel() }
            return try await SpecializedHealthReader.ecgPayload(classification: 0, symptomsStatus: 0, averageHeartRate: nil, samplingFrequency: nil, count: 0, measurements: { XCTFail("Cancelled task must not query"); return [] })
        }
        do { _ = try await operation.value; XCTFail("Expected cancellation") } catch { XCTAssertTrue(error is CancellationError) }
    }
}
