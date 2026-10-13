import Foundation

/// Enum meanings follow the SDK; non-example English labels are a documented profile,
/// pending real HEA captures. MenstrualFlow and SexualActivity require family context.
enum HEACategoryEncoder {
    struct Category { let name: String; let values: [Int: String] }
    static let symptoms: [String: Category] = [
        "HKCategoryTypeIdentifierAbdominalCramps": Category(name: "Abdominal Cramps", values: [0: "Unspecified", 1: "Not Present", 2: "Mild", 3: "Moderate", 4: "Severe"]),
        "HKCategoryTypeIdentifierAcne": Category(name: "Acne", values: [0: "Unspecified", 1: "Not Present", 2: "Mild", 3: "Moderate", 4: "Severe"]),
        "HKCategoryTypeIdentifierAppetiteChanges": Category(name: "Appetite Changes", values: [0: "Unspecified", 1: "No Change", 2: "Decreased", 3: "Increased"]),
        "HKCategoryTypeIdentifierBladderIncontinence": Category(name: "Bladder Incontinence", values: [0: "Unspecified", 1: "Not Present", 2: "Mild", 3: "Moderate", 4: "Severe"]),
        "HKCategoryTypeIdentifierBloating": Category(name: "Bloating", values: [0: "Unspecified", 1: "Not Present", 2: "Mild", 3: "Moderate", 4: "Severe"]),
        "HKCategoryTypeIdentifierBreastPain": Category(name: "Breast Pain", values: [0: "Unspecified", 1: "Not Present", 2: "Mild", 3: "Moderate", 4: "Severe"]),
        "HKCategoryTypeIdentifierChestTightnessOrPain": Category(name: "Chest Tightness or Pain", values: [0: "Unspecified", 1: "Not Present", 2: "Mild", 3: "Moderate", 4: "Severe"]),
        "HKCategoryTypeIdentifierChills": Category(name: "Chills", values: [0: "Unspecified", 1: "Not Present", 2: "Mild", 3: "Moderate", 4: "Severe"]),
        "HKCategoryTypeIdentifierConstipation": Category(name: "Constipation", values: [0: "Unspecified", 1: "Not Present", 2: "Mild", 3: "Moderate", 4: "Severe"]),
        "HKCategoryTypeIdentifierCoughing": Category(name: "Coughing", values: [0: "Unspecified", 1: "Not Present", 2: "Mild", 3: "Moderate", 4: "Severe"]),
        "HKCategoryTypeIdentifierDiarrhea": Category(name: "Diarrhea", values: [0: "Unspecified", 1: "Not Present", 2: "Mild", 3: "Moderate", 4: "Severe"]),
        "HKCategoryTypeIdentifierDizziness": Category(name: "Dizziness", values: [0: "Unspecified", 1: "Not Present", 2: "Mild", 3: "Moderate", 4: "Severe"]),
        "HKCategoryTypeIdentifierDrySkin": Category(name: "Dry Skin", values: [0: "Unspecified", 1: "Not Present", 2: "Mild", 3: "Moderate", 4: "Severe"]),
        "HKCategoryTypeIdentifierFainting": Category(name: "Fainting", values: [0: "Unspecified", 1: "Not Present", 2: "Mild", 3: "Moderate", 4: "Severe"]),
        "HKCategoryTypeIdentifierFatigue": Category(name: "Fatigue", values: [0: "Unspecified", 1: "Not Present", 2: "Mild", 3: "Moderate", 4: "Severe"]),
        "HKCategoryTypeIdentifierFever": Category(name: "Fever", values: [0: "Unspecified", 1: "Not Present", 2: "Mild", 3: "Moderate", 4: "Severe"]),
        "HKCategoryTypeIdentifierGeneralizedBodyAche": Category(name: "Body Ache", values: [0: "Unspecified", 1: "Not Present", 2: "Mild", 3: "Moderate", 4: "Severe"]),
        "HKCategoryTypeIdentifierHairLoss": Category(name: "Hair Loss", values: [0: "Unspecified", 1: "Not Present", 2: "Mild", 3: "Moderate", 4: "Severe"]),
        "HKCategoryTypeIdentifierHeadache": Category(name: "Headache", values: [0: "Unspecified", 1: "Not Present", 2: "Mild", 3: "Moderate", 4: "Severe"]),
        "HKCategoryTypeIdentifierHeartburn": Category(name: "Heartburn", values: [0: "Unspecified", 1: "Not Present", 2: "Mild", 3: "Moderate", 4: "Severe"]),
        "HKCategoryTypeIdentifierHotFlashes": Category(name: "Hot Flashes", values: [0: "Unspecified", 1: "Not Present", 2: "Mild", 3: "Moderate", 4: "Severe"]),
        "HKCategoryTypeIdentifierLossOfSmell": Category(name: "Loss of Smell", values: [0: "Unspecified", 1: "Not Present", 2: "Mild", 3: "Moderate", 4: "Severe"]),
        "HKCategoryTypeIdentifierLossOfTaste": Category(name: "Loss of Taste", values: [0: "Unspecified", 1: "Not Present", 2: "Mild", 3: "Moderate", 4: "Severe"]),
        "HKCategoryTypeIdentifierLowerBackPain": Category(name: "Lower Back Pain", values: [0: "Unspecified", 1: "Not Present", 2: "Mild", 3: "Moderate", 4: "Severe"]),
        "HKCategoryTypeIdentifierMemoryLapse": Category(name: "Memory Lapse", values: [0: "Unspecified", 1: "Not Present", 2: "Mild", 3: "Moderate", 4: "Severe"]),
        "HKCategoryTypeIdentifierMoodChanges": Category(name: "Mood Changes", values: [0: "Present", 1: "Not Present"]),
        "HKCategoryTypeIdentifierNausea": Category(name: "Nausea", values: [0: "Unspecified", 1: "Not Present", 2: "Mild", 3: "Moderate", 4: "Severe"]),
        "HKCategoryTypeIdentifierNightSweats": Category(name: "Night Sweats", values: [0: "Unspecified", 1: "Not Present", 2: "Mild", 3: "Moderate", 4: "Severe"]),
        "HKCategoryTypeIdentifierPelvicPain": Category(name: "Pelvic Pain", values: [0: "Unspecified", 1: "Not Present", 2: "Mild", 3: "Moderate", 4: "Severe"]),
        "HKCategoryTypeIdentifierRapidPoundingOrFlutteringHeartbeat": Category(name: "Rapid Pounding or Fluttering Heartbeat", values: [0: "Unspecified", 1: "Not Present", 2: "Mild", 3: "Moderate", 4: "Severe"]),
        "HKCategoryTypeIdentifierRunnyNose": Category(name: "Runny Nose", values: [0: "Unspecified", 1: "Not Present", 2: "Mild", 3: "Moderate", 4: "Severe"]),
        "HKCategoryTypeIdentifierShortnessOfBreath": Category(name: "Shortness of Breath", values: [0: "Unspecified", 1: "Not Present", 2: "Mild", 3: "Moderate", 4: "Severe"]),
        "HKCategoryTypeIdentifierSinusCongestion": Category(name: "Sinus Congestion", values: [0: "Unspecified", 1: "Not Present", 2: "Mild", 3: "Moderate", 4: "Severe"]),
        "HKCategoryTypeIdentifierSkippedHeartbeat": Category(name: "Skipped Heartbeat", values: [0: "Unspecified", 1: "Not Present", 2: "Mild", 3: "Moderate", 4: "Severe"]),
        "HKCategoryTypeIdentifierSleepChanges": Category(name: "Sleep Changes", values: [0: "Present", 1: "Not Present"]),
        "HKCategoryTypeIdentifierSoreThroat": Category(name: "Sore Throat", values: [0: "Unspecified", 1: "Not Present", 2: "Mild", 3: "Moderate", 4: "Severe"]),
        "HKCategoryTypeIdentifierVaginalDryness": Category(name: "Vaginal Dryness", values: [0: "Unspecified", 1: "Not Present", 2: "Mild", 3: "Moderate", 4: "Severe"]),
        "HKCategoryTypeIdentifierVomiting": Category(name: "Vomiting", values: [0: "Unspecified", 1: "Not Present", 2: "Mild", 3: "Moderate", 4: "Severe"]),
        "HKCategoryTypeIdentifierWheezing": Category(name: "Wheezing", values: [0: "Unspecified", 1: "Not Present", 2: "Mild", 3: "Moderate", 4: "Severe"]),
    ]
    static let cycle: [String: Category] = [
        "HKCategoryTypeIdentifierCervicalMucusQuality": Category(name: "Cervical Mucus Quality", values: [1: "Dry", 2: "Sticky", 3: "Creamy", 4: "Watery", 5: "Egg White"]),
        "HKCategoryTypeIdentifierContraceptive": Category(name: "Contraceptive", values: [1: "", 2: "", 3: "", 4: "", 5: "", 6: "", 7: ""]),
        "HKCategoryTypeIdentifierInfrequentMenstrualCycles": Category(name: "Infrequent Menstrual Cycle", values: [0: ""]),
        "HKCategoryTypeIdentifierIntermenstrualBleeding": Category(name: "Intermenstrual Bleeding", values: [0: ""]),
        "HKCategoryTypeIdentifierIrregularMenstrualCycles": Category(name: "Irregular Menstrual Cycle", values: [0: ""]),
        "HKCategoryTypeIdentifierLactation": Category(name: "Lactation", values: [0: ""]),
        "HKCategoryTypeIdentifierMenstrualFlow": Category(name: "Menstrual Flow", values: [1: "Unspecified", 2: "Light", 3: "Medium", 4: "Heavy", 5: "None"]),
        "HKCategoryTypeIdentifierOvulationTestResult": Category(name: "Ovulation Test Result", values: [1: "Negative/Low", 2: "Positive/Peak", 3: "Indeterminate", 4: "High"]),
        "HKCategoryTypeIdentifierPersistentIntermenstrualBleeding": Category(name: "Persistent Menstrual Bleeding", values: [0: ""]),
        "HKCategoryTypeIdentifierPregnancy": Category(name: "Pregnancy", values: [0: ""]),
        "HKCategoryTypeIdentifierPregnancyTestResult": Category(name: "Pregnancy Test Result", values: [1: "Negative", 2: "Positive", 3: "Indeterminate"]),
        "HKCategoryTypeIdentifierProgesteroneTestResult": Category(name: "Progesterone Test Result", values: [1: "Negative", 2: "Positive", 3: "Indeterminate"]),
        "HKCategoryTypeIdentifierProlongedMenstrualPeriods": Category(name: "Prolonged Menstrual Period", values: [0: ""]),
        "HKCategoryTypeIdentifierSexualActivity": Category(name: "Sexual Activity", values: [0: ""]),
    ]
    static func encode(_ record: HealthRecord, family: HEADataType, dates: HEADates) throws -> JSONValue {
        let category: Category?
        if family == .symptoms {
            // Explicit symptoms context follows the MenstrualFlow flow enum, never severity numbers.
            category = symptoms[record.typeIdentifier] ?? (record.typeIdentifier == "HKCategoryTypeIdentifierMenstrualFlow" ? cycle[record.typeIdentifier] : nil)
        } else { category = cycle[record.typeIdentifier] }
        guard let category, let payload = record.payload else { throw ConfigurationError("HEA 分类记录无效") }
        _ = try dates.interval(record)
        var point: [String: JSONValue] = ["start": .string(try dates.string(record.start)), "end": .string(try dates.string(record.end)), "name": .string(category.name)]
        let value = try HEAValue.enumName(payload["value"], category.values, record.typeIdentifier)
        let metadata = payload["metadata"]?.object ?? [:]
        if family == .symptoms {
            point["severity"] = .string(value)
            if let source = record.source { point["source"] = .string(source.name) }
            if case .bool = metadata["HKWasUserEntered"] { point["userEntered"] = metadata["HKWasUserEntered"] }
        } else {
            point["value"] = .string(value)
            if record.typeIdentifier == "HKCategoryTypeIdentifierMenstrualFlow", metadata["HKMenstrualCycleStart"] == .bool(true) { point["isCycleStart"] = .bool(true) }
        }
        return .object(point)
    }
}
