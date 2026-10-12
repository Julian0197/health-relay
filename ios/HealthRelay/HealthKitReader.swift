import Foundation
import HealthKit
import HealthRelayCore

@MainActor final class HealthKitReader: HealthDataReader, AggregateSource {
    let health = HKHealthStore()

    func sampleType(_ id: String) throws -> HKSampleType {
        guard let metric = MetricCatalog.bundled.metric(id), metric.minimumIOS <= ProcessInfo.processInfo.operatingSystemVersion.majorVersion else {
            throw ConfigurationError("当前系统不支持这个健康数据类型")
        }
        let type: HKSampleType?
        switch metric.family {
        case .quantity: type = HKObjectType.quantityType(forIdentifier: .init(rawValue: id))
        case .category: type = HKObjectType.categoryType(forIdentifier: .init(rawValue: id))
        case .correlation: type = HKObjectType.correlationType(forIdentifier: .init(rawValue: id))
        case .workout: type = HKObjectType.workoutType()
        case .healthMetrics: type = nil
        }
        guard let type else { throw ConfigurationError("当前系统无法创建所选健康数据类型") }
        return type
    }
    func authorize(_ task: AutomationConfig) async throws {
        guard HKHealthStore.isHealthDataAvailable() else { throw ConfigurationError("此设备无法访问健康数据") }
        var types = Set<HKObjectType>()
        for selection in task.data.selections {
            let type = try sampleType(selection.id)
            if type is HKCorrelationType {
                // HealthKit grants correlation access through the contained quantity types.
                let identifiers = selection.id == "HKCorrelationTypeIdentifierBloodPressure"
                    ? ["HKQuantityTypeIdentifierBloodPressureSystolic", "HKQuantityTypeIdentifierBloodPressureDiastolic"]
                    : MetricCatalog.bundled.metrics.filter { $0.id.contains("IdentifierDietary") }.map(\.id)
                for id in identifiers { types.insert(try sampleType(id)) }
            } else { types.insert(type) }
        }
        try await health.requestAuthorization(toShare: [], read: types)
    }
    func read(task: AutomationConfig, selection: MetricSelection, checkpoint: TypeCheckpoint, limit: Int) async throws -> ReadPage {
        if task.export.mode == .aggregate { return try await AggregationReader(source: self).read(task: task, selection: selection, checkpoint: checkpoint, limit: limit) }
        return try await readChanges(task: task, selection: selection, checkpoint: checkpoint, limit: limit)
    }
    func readChanges(task: AutomationConfig, selection: MetricSelection, checkpoint: TypeCheckpoint, limit: Int) async throws -> ReadPage {
        let type = try sampleType(selection.id)
        let anchor = try checkpoint.anchor.map { data in
            guard let value = try NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: data) else { throw ConfigurationError("健康数据游标损坏，已停止读取") }
            return value
        }
        // Keep the same date predicate for every page and later incremental run.
        let aggregate = task.export.mode == .aggregate
        let isSleep = selection.id == "HKCategoryTypeIdentifierSleepAnalysis"
        let start = aggregate ? try AggregateWindow.containing(checkpoint.start, grouping: task.export.grouping, timeZone: task.export.timeZone, sleep: isSleep).start : checkpoint.start
        let end = aggregate ? try checkpoint.end.map { try AggregateWindow.containing($0.addingTimeInterval(-0.001), grouping: task.export.grouping, timeZone: task.export.timeZone, sleep: isSleep).end } : checkpoint.end
        let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: aggregate ? [] : .strictStartDate)
        let descriptor = HKAnchoredObjectQueryDescriptor(predicates: [.sample(type: type, predicate: predicate)], anchor: anchor, limit: limit)
        let result = try await descriptor.result(for: health)
        let allowed = result.addedSamples.filter { sample in
            let source = sample.sourceRevision.source.bundleIdentifier
            return (selection.sources.isEmpty || selection.sources.contains(source)) && !task.data.excludedSources.contains(source)
                && (end == nil || sample.startDate < end!)
        }
        var records = try allowed.map { try record($0, unit: selection.unit) }
        // Deletions have only a UUID. Receivers ignore delete events for UUIDs they never imported.
        records += result.deletedObjects.map { HealthRecord(op: .delete, typeIdentifier: selection.id, recordId: $0.uuid.uuidString.lowercased()) }
        return ReadPage(records: records, anchor: try NSKeyedArchiver.archivedData(withRootObject: result.newAnchor, requiringSecureCoding: true), hasMore: result.addedSamples.count + result.deletedObjects.count >= limit)
    }
    func snapshot(task: AutomationConfig, selection: MetricSelection, window: AggregateWindow) async throws -> [String: JSONValue]? {
        let type = try sampleType(selection.id)
        var predicates = [HKQuery.predicateForSamples(withStart: window.start, end: window.end, options: [])]
        if !selection.sources.isEmpty || !task.data.excludedSources.isEmpty {
            let sources = try await HKSourceQueryDescriptor(predicate: .sample(type: type, predicate: nil)).result(for: health)
            let allowed = sources.filter { (selection.sources.isEmpty || selection.sources.contains($0.bundleIdentifier)) && !task.data.excludedSources.contains($0.bundleIdentifier) }
            guard !allowed.isEmpty else { return nil }
            predicates.append(HKQuery.predicateForObjects(from: Set(allowed)))
        }
        let predicate = NSCompoundPredicate(andPredicateWithSubpredicates: predicates)
        if selection.id == "HKCategoryTypeIdentifierSleepAnalysis", let category = type as? HKCategoryType {
            let samples = try await HKSampleQueryDescriptor(predicates: [.categorySample(type: category, predicate: predicate)], sortDescriptors: [SortDescriptor(\HKCategorySample.startDate)], limit: nil).result(for: health)
            return SleepSummary.payload(records: try samples.map { try record($0, unit: nil) }, window: window, timeZone: task.export.timeZone)
        }
        guard let quantity = type as? HKQuantityType, let unitCode = selection.unit else { throw ConfigurationError("此类型尚不支持汇总") }
        let selected = task.statistics(for: selection)
        var options: HKStatisticsOptions = []
        for statistic in selected {
            switch statistic { case .sum: options.insert(.cumulativeSum); case .average: options.insert(.discreteAverage); case .minimum: options.insert(.discreteMin); case .maximum: options.insert(.discreteMax) }
        }
        let descriptor = HKStatisticsCollectionQueryDescriptor(predicate: .quantitySample(type: quantity, predicate: predicate), options: options, anchorDate: window.start, intervalComponents: DateComponents(second: Int(window.end.timeIntervalSince(window.start))))
        let collection = try await descriptor.result(for: health)
        guard let statistics = collection.statistics(for: window.start) else { return nil }
        let outputUnit = try Self.unit(unitCode)
        var payload: [String: JSONValue] = ["aggregation": .bool(true), "unit": .string(unitCode)]
        for statistic in selected {
            let value: HKQuantity?
            switch statistic { case .sum: value = statistics.sumQuantity(); case .average: value = statistics.averageQuantity(); case .minimum: value = statistics.minimumQuantity(); case .maximum: value = statistics.maximumQuantity() }
            if let value { payload[statistic.rawValue] = .number(value.doubleValue(for: outputUnit)) }
        }
        guard let preferred = payload["sum"] ?? payload["average"] ?? payload["minimum"] ?? payload["maximum"] else { return nil }
        payload["value"] = preferred
        return payload
    }

    private func record(_ sample: HKSample, unit: String?) throws -> HealthRecord {
        var payload: [String: JSONValue] = [:]
        if let quantity = sample as? HKQuantitySample {
            let code = unit ?? MetricCatalog.bundled.metric(sample.sampleType.identifier)?.units.first
            guard let code else { throw ConfigurationError("数量指标缺少输出单位") }
            let native = try Self.unit(code)
            guard quantity.quantity.is(compatibleWith: native) else { throw ConfigurationError("所选单位与 HealthKit 数据不兼容：\(code)") }
            payload["value"] = .number(quantity.quantity.doubleValue(for: native)); payload["unit"] = .string(code)
        } else if let category = sample as? HKCategorySample {
            payload["value"] = .number(Double(category.value))
        } else if let correlation = sample as? HKCorrelation {
            let objects = try correlation.objects.sorted { $0.uuid.uuidString < $1.uuid.uuidString }.map {
                let child = try record($0, unit: nil)
                let data = try JSONEncoder().encode(child)
                return try JSONDecoder().decode(JSONValue.self, from: data)
            }
            payload["objects"] = .array(objects)
        } else if let workout = sample as? HKWorkout {
            payload["activityType"] = .number(Double(workout.workoutActivityType.rawValue))
            payload["durationSeconds"] = .number(workout.duration)
            payload["events"] = .array((workout.workoutEvents ?? []).map {
                .object(["type": .number(Double($0.type.rawValue)), "start": .string(Self.date($0.dateInterval.start)), "end": .string(Self.date($0.dateInterval.end))])
            })
            var statistics: [String: JSONValue] = [:]
            for (type, stats) in workout.allStatistics {
                guard let code = MetricCatalog.bundled.metric(type.identifier)?.units.first else { continue }
                let unit = try Self.unit(code)
                var values: [String: JSONValue] = ["unit": .string(code)]
                for (name, quantity) in [("sum", stats.sumQuantity()), ("average", stats.averageQuantity()), ("minimum", stats.minimumQuantity()), ("maximum", stats.maximumQuantity())] {
                    if let quantity, quantity.is(compatibleWith: unit) { values[name] = .number(quantity.doubleValue(for: unit)) }
                }
                statistics[type.identifier] = .object(values)
            }
            payload["statistics"] = .object(statistics)
        } else { throw ConfigurationError("该 HealthKit 记录需要独立读取器") }
        var metadata: [String: JSONValue] = [:]
        var unsupported: [JSONValue] = []
        for (key, value) in sample.metadata ?? [:] {
            if let text = value as? String { metadata[key] = .string(text) }
            else if let date = value as? Date { metadata[key] = .string(Self.date(date)) }
            else if let number = value as? NSNumber {
                metadata[key] = CFGetTypeID(number) == CFBooleanGetTypeID() ? .bool(number.boolValue) : .number(number.doubleValue)
            } else { unsupported.append(.string(key)) }
        }
        if !metadata.isEmpty { payload["metadata"] = .object(metadata) }
        if !unsupported.isEmpty { payload["unsupportedMetadataKeys"] = .array(unsupported) }
        let revision = sample.sourceRevision
        return HealthRecord(op: .upsert, typeIdentifier: sample.sampleType.identifier, recordId: sample.uuid.uuidString.lowercased(), start: Self.date(sample.startDate), end: Self.date(sample.endDate), source: RecordSource(id: revision.source.bundleIdentifier, name: revision.source.name, version: revision.version, device: sample.device?.model), payload: payload)
    }
    static func date(_ date: Date) -> String { HealthTimestamp.string(date) }
    static func unit(_ code: String) throws -> HKUnit {
        switch code {
        case "%": return .percent()
        case "kg": return .gramUnit(with: .kilo)
        case "g": return .gram()
        case "mg": return .gramUnit(with: .milli)
        case "mcg": return .gramUnit(with: .micro)
        case "lb": return .pound()
        case "m": return .meter()
        case "cm": return .meterUnit(with: .centi)
        case "km": return .meterUnit(with: .kilo)
        case "mi": return .mile()
        case "s": return .second()
        case "ms": return .secondUnit(with: .milli)
        case "min": return .minute()
        case "hr": return .hour()
        case "kcal": return .kilocalorie()
        case "kJ": return .jouleUnit(with: .kilo)
        case "L": return .liter()
        case "mL": return .literUnit(with: .milli)
        case "degC": return .degreeCelsius()
        case "degF": return .degreeFahrenheit()
        case "mmHg": return .millimeterOfMercury()
        case "kPa": return .pascalUnit(with: .kilo)
        case "count": return .count()
        case "count/min": return HKUnit.count().unitDivided(by: .minute())
        case "count/s": return HKUnit.count().unitDivided(by: .second())
        case "m/s": return HKUnit.meter().unitDivided(by: .second())
        case "km/hr": return HKUnit.meterUnit(with: .kilo).unitDivided(by: .hour())
        case "mi/hr": return HKUnit.mile().unitDivided(by: .hour())
        case "L/min": return HKUnit.liter().unitDivided(by: .minute())
        case "mg/dL": return HKUnit.gramUnit(with: .milli).unitDivided(by: .literUnit(with: .deci))
        case "mL/(kg*min)": return HKUnit.literUnit(with: .milli).unitDivided(by: HKUnit.gramUnit(with: .kilo).unitMultiplied(by: .minute()))
        case "kcal/(hr*kg)": return HKUnit.kilocalorie().unitDivided(by: HKUnit.hour().unitMultiplied(by: .gramUnit(with: .kilo)))
        case "S": return .siemen()
        case "W": return .watt()
        case "IU": return .internationalUnit()
        case "dBASPL": return .decibelAWeightedSoundPressureLevel()
        case "appleEffortScore": return .appleEffortScore()
        default: throw ConfigurationError("尚未支持这个输出单位：\(code)")
        }
    }
}
