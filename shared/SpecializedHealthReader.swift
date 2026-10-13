import Foundation
import HealthKit
import HealthRelayCore

struct ECGMeasurement {
    let offsetSeconds: Double
    let voltage: HKQuantity?
}

@MainActor enum SpecializedHealthReader {
    static let notificationIDs: Set<String> = ["HKCategoryTypeIdentifierHighHeartRateEvent", "HKCategoryTypeIdentifierLowHeartRateEvent", "HKCategoryTypeIdentifierIrregularHeartRhythmEvent"]
    static var notificationTypes: Set<HKQuantityType> { [HKQuantityType(.heartRate), HKQuantityType(.heartRateVariabilitySDNN)] }

    @available(iOS 18, watchOS 11, *)
    static func stateOfMind(_ sample: HKStateOfMind) -> [String: JSONValue] {
        ["kind": .number(Double(sample.kind.rawValue)), "valence": .number(sample.valence),
         "valenceClassification": .number(Double(sample.valenceClassification.rawValue)),
         "labels": .array(sample.labels.map { .number(Double($0.rawValue)) }),
         "associations": .array(sample.associations.map { .number(Double($0.rawValue)) })]
    }

    static func ecgPayload(classification: Int, symptomsStatus: Int, averageHeartRate: HKQuantity?, samplingFrequency: HKQuantity?, count: Int, measurements: () async throws -> [ECGMeasurement]) async throws -> [String: JSONValue] {
        try Task.checkCancellation()
        let points = try await measurements()
        try Task.checkCancellation()
        guard points.count == count else { throw ConfigurationError("心电图波形未完整读取，请重试") }
        var payload: [String: JSONValue] = [
            "classification": .number(Double(classification)), "symptomsStatus": .number(Double(symptomsStatus)),
            "numberOfVoltageMeasurements": .number(Double(count)),
            "voltageMeasurements": .array(try points.map { point in
                guard let voltage = point.voltage else { throw ConfigurationError("心电图缺少 Lead I 电压") }
                return .object(["offsetMilliseconds": try WorkoutReader.number(point.offsetSeconds * 1000),
                                "voltage": try WorkoutReader.number(voltage.doubleValue(for: .volt())), "unit": .string("V")])
            })]
        if let averageHeartRate { payload["averageHeartRate"] = try WorkoutReader.quantity(averageHeartRate, preferredUnit: "count/min") }
        if let samplingFrequency { payload["samplingFrequency"] = .object(["value": try WorkoutReader.number(samplingFrequency.doubleValue(for: .hertz())), "unit": .string("Hz")]) }
        return payload
    }

    static func medicationPayload(logStatus: Int, scheduleType: Int, scheduledDate: Date?, doseQuantity: Double?, scheduledDoseQuantity: Double?, unit: String, conceptIdentifier: JSONValue, annotation: [String: JSONValue]?) throws -> [String: JSONValue] {
        var payload: [String: JSONValue] = ["logStatus": .number(Double(logStatus)), "scheduleType": .number(Double(scheduleType)),
            "unit": .string(unit), "medicationConceptIdentifier": conceptIdentifier,
            "annotationStatus": .string(annotation == nil ? "notReturned" : "available")]
        if let scheduledDate { payload["scheduledDate"] = .string(HealthKitReader.date(scheduledDate)) }
        if let doseQuantity { payload["doseQuantity"] = try WorkoutReader.number(doseQuantity) }
        if let scheduledDoseQuantity { payload["scheduledDoseQuantity"] = try WorkoutReader.number(scheduledDoseQuantity) }
        if let annotation { payload["medication"] = .object(annotation) }
        return payload
    }

    static func readECG(_ sample: HKElectrocardiogram, reader: HealthKitReader) async throws -> [String: JSONValue] {
        try await ecgPayload(classification: sample.classification.rawValue, symptomsStatus: sample.symptomsStatus.rawValue,
                             averageHeartRate: sample.averageHeartRate, samplingFrequency: sample.samplingFrequency,
                             count: sample.numberOfVoltageMeasurements, measurements: {
            var measurements: [ECGMeasurement] = []
            for try await measurement in HKElectrocardiogramQueryDescriptor(sample).results(for: reader.health) {
                try Task.checkCancellation()
                measurements.append(ECGMeasurement(offsetSeconds: measurement.timeSinceSampleStart,
                    voltage: measurement.quantity(for: .appleWatchSimilarToLeadI)))
            }
            return measurements
        })
    }

    @available(iOS 26, watchOS 26, *)
    static func medication(_ sample: HKMedicationDoseEvent, annotation: [String: JSONValue]?) throws -> [String: JSONValue] {
        // HealthKit exposes equality and NSSecureCoding, but no textual concept ID.
        let identifier = sample.medicationConceptIdentifier
        let concept: JSONValue = .object(["domain": .string(identifier.domain.rawValue),
            "archive": .string(try NSKeyedArchiver.archivedData(withRootObject: identifier, requiringSecureCoding: true).base64EncodedString())])
        return try medicationPayload(logStatus: sample.logStatus.rawValue, scheduleType: sample.scheduleType.rawValue,
            scheduledDate: sample.scheduledDate, doseQuantity: sample.doseQuantity, scheduledDoseQuantity: sample.scheduledDoseQuantity,
            unit: sample.unit.unitString, conceptIdentifier: concept, annotation: annotation)
    }

    @available(iOS 26, watchOS 26, *)
    static func medicationAnnotations(reader: HealthKitReader) async throws -> [NSObject: [String: JSONValue]] {
        try Task.checkCancellation()
        let annotations = try await HKUserAnnotatedMedicationQueryDescriptor().result(for: reader.health)
        try Task.checkCancellation()
        var result: [NSObject: [String: JSONValue]] = [:]
        for annotation in annotations {
            let medication = annotation.medication
            let codings = medication.relatedCodings.sorted { ($0.system, $0.code, $0.version ?? "") < ($1.system, $1.code, $1.version ?? "") }
            var value: [String: JSONValue] = ["displayText": .string(medication.displayText), "generalForm": .string(medication.generalForm.rawValue),
                "isArchived": .bool(annotation.isArchived), "hasSchedule": .bool(annotation.hasSchedule),
                "relatedCodings": .array(codings.map { .object(["code": .string($0.code), "system": .string($0.system), "version": $0.version.map(JSONValue.string) ?? .null]) })]
            if let nickname = annotation.nickname { value["nickname"] = .string(nickname) }
            result[medication.identifier] = value
        }
        return result
    }

    static func notification(_ sample: HKCategorySample, record: HealthRecord, reader: HealthKitReader, task: AutomationConfig, selection: MetricSelection) async throws -> HealthRecord {
        let overlap = HKQuery.predicateForSamples(withStart: sample.startDate, end: sample.endDate, options: [])
        let predicates = notificationTypes.sorted { $0.identifier < $1.identifier }.map { HKSamplePredicate.quantitySample(type: $0, predicate: overlap) }
        let queries = reader.workoutQueries ?? WorkoutQueries.live(reader: reader)
        let data = try await queries.quantities(predicates)
        try Task.checkCancellation()
        var children: [JSONValue] = []
        for item in data.sorted(by: { ($0.sample.startDate, $0.sample.uuid.uuidString) < ($1.sample.startDate, $1.sample.uuid.uuidString) }) {
            let source = item.sample.sourceRevision.source.bundleIdentifier
            guard (selection.sources.isEmpty || selection.sources.contains(source)), !task.data.excludedSources.contains(source) else { continue }
            try Task.checkCancellation()
            var child = try reader.record(item.sample, unit: nil)
            child.payload?["quantityCount"] = .number(Double(item.count))
            if item.count > 1 {
                let points = try await item.series()
                try Task.checkCancellation()
                guard points.count == item.count else { throw ConfigurationError("心率通知关联序列未完整读取，请重试") }
                guard case .string(let code)? = child.payload?["unit"] else { throw ConfigurationError("心率通知关联序列缺少单位") }
                let unit = try HealthKitReader.unit(code)
                child.payload?["series"] = .array(try points.map { point in
                    .object(["start": .string(HealthKitReader.date(point.interval.start)), "end": .string(HealthKitReader.date(point.interval.end)), "value": try WorkoutReader.number(point.quantity.doubleValue(for: unit))])
                })
            }
            children.append(try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(child)))
        }
        var result = record
        result.payload?["associationPolicy"] = .string("overlap-event-interval-v1")
        result.payload?["associatedQuantities"] = .array(children)
        return result
    }
}
