import Foundation

/// V1 uses the published legacy example; V2 uses the documented workout schema.
/// SDK activity IDs are exact; names beyond Running/Cycling/Swimming are provisional English labels.
enum HEAWorkoutEncoder {
    static let activityNames: [Int: String] = [
        1: "American Football",
        2: "Archery",
        3: "Australian Football",
        4: "Badminton",
        5: "Baseball",
        6: "Basketball",
        7: "Bowling",
        8: "Boxing",
        9: "Climbing",
        10: "Cricket",
        11: "Cross Training",
        12: "Curling",
        13: "Cycling",
        14: "Dance",
        15: "Dance Inspired Training",
        16: "Elliptical",
        17: "Equestrian Sports",
        18: "Fencing",
        19: "Fishing",
        20: "Functional Strength Training",
        21: "Golf",
        22: "Gymnastics",
        23: "Handball",
        24: "Hiking",
        25: "Hockey",
        26: "Hunting",
        27: "Lacrosse",
        28: "Martial Arts",
        29: "Mind And Body",
        30: "Mixed Metabolic Cardio Training",
        31: "Paddle Sports",
        32: "Play",
        33: "Preparation And Recovery",
        34: "Racquetball",
        35: "Rowing",
        36: "Rugby",
        37: "Running",
        38: "Sailing",
        39: "Skating Sports",
        40: "Snow Sports",
        41: "Soccer",
        42: "Softball",
        43: "Squash",
        44: "Stair Climbing",
        45: "Surfing Sports",
        46: "Swimming",
        47: "Table Tennis",
        48: "Tennis",
        49: "Track And Field",
        50: "Traditional Strength Training",
        51: "Volleyball",
        52: "Walking",
        53: "Water Fitness",
        54: "Water Polo",
        55: "Water Sports",
        56: "Wrestling",
        57: "Yoga",
        58: "Barre",
        59: "Core Training",
        60: "Cross Country Skiing",
        61: "Downhill Skiing",
        62: "Flexibility",
        63: "High Intensity Interval Training",
        64: "Jump Rope",
        65: "Kickboxing",
        66: "Pilates",
        67: "Snowboarding",
        68: "Stairs",
        69: "Step Training",
        70: "Wheelchair Walk Pace",
        71: "Wheelchair Run Pace",
        72: "Tai Chi",
        73: "Mixed Cardio",
        74: "Hand Cycling",
        75: "Disc Sports",
        76: "Fitness Gaming",
        77: "Cardio Dance",
        78: "Social Dance",
        79: "Pickleball",
        80: "Cooldown",
        82: "Swim Bike Run",
        83: "Transition",
        84: "Underwater Diving",
        // SDK-unavailable 2998 (Rest) / 2999 (Group) deliberately have no executable mapping.
        3000: "Other",
    ]
    static func encode(_ record: HealthRecord, version: Int, dates: HEADates) throws -> JSONValue {
        guard let payload = record.payload else { throw ConfigurationError("HEA 锻炼缺少数据") }
        _ = try dates.interval(record)
        let name = try HEAValue.enumName(payload["activityType"], activityNames, "workout.activityType")
        var result: [String: JSONValue] = ["name": .string(name), "start": .string(try dates.string(record.start)), "end": .string(try dates.string(record.end))]
        if version == 2 {
            let duration = try HEAValue.number(payload["durationSeconds"], "durationSeconds")
            guard duration >= 0 else { throw ConfigurationError("HEA 锻炼时长无效") }
            result["id"] = .string(record.recordId); result["duration"] = .number(duration)
        }
        let statistics = payload["statistics"]?.object ?? [:], totals = payload["totals"]?.object ?? [:]
        func statistic(_ type: String, field: String = "sum") -> JSONValue? {
            guard let stats = statistics["HKQuantityTypeIdentifier" + type]?.object, let number = stats[field] else { return nil }
            return .object(["value": number, "unit": stats["unit"] ?? .null])
        }
        let active = try (statistic("ActiveEnergyBurned") ?? totals["energyBurned"]).map { try HEAValue.quantity($0, unit: "kcal") }
        result[version == 1 ? "activeEnergy" : "activeEnergyBurned"] = active
        if let active = active?.object?["qty"]?.number, let basal = statistic("BasalEnergyBurned") {
            let rest = try HEAValue.quantity(basal, unit: "kcal").object!["qty"]!.number!
            result["totalEnergy"] = .object(["qty": .number(active + rest), "units": .string("kcal")])
        }
        // Single-activity fallback only. Never add duplicate distance totals/statistics.
        let distanceType: String? = switch payload["activityType"]?.number {
        case 13: "DistanceCycling"
        case 37, 52: "DistanceWalkingRunning"
        case 46: "DistanceSwimming"
        case 70, 71: "DistanceWheelchair"
        case 61, 67: "DistanceDownhillSnowSports"
        default: nil
        }
        if let distance = distanceType.flatMap({ statistic($0) }) ?? totals["distance"] { result["distance"] = try HEAValue.quantity(distance, unit: "km") }
        if version == 2 {
            for (type, total, key) in [("FlightsClimbed", "flightsClimbed", "flightsClimbed"), ("SwimmingStrokeCount", "swimmingStrokeCount", "totalSwimmingStrokeCount")] {
                if let value = statistic(type) ?? totals[total] { result[key] = try HEAValue.quantity(value, unit: "count") }
            }
            var heartRate: [String: JSONValue] = [:]
            for (native, key) in [("minimum", "min"), ("average", "avg"), ("maximum", "max")] {
                if let value = statistic("HeartRate", field: native) { heartRate[key] = try HEAValue.quantity(value, unit: "bpm") }
            }
            if !heartRate.isEmpty { result["heartRate"] = .object(heartRate) }
            result["avgHeartRate"] = heartRate["avg"]; result["maxHeartRate"] = heartRate["max"]
            try addMetadata(payload, to: &result)
            try addSeries(payload, to: &result, dates: dates)
        }
        if let routes = payload["routes"]?.array {
            var locations: [(Date, Int, [String: JSONValue])] = []
            for route in routes {
                guard let points = route.object?["payload"]?.object?["locations"]?.array else { throw ConfigurationError("HEA 锻炼路线无效") }
                for point in points {
                    guard let point = point.object else { throw ConfigurationError("HEA 路线坐标无效") }
                    locations.append((try dates.date(point["timestamp"]?.text), locations.count, point))
                }
            }
            result["route"] = .array(try locations.sorted { ($0.0, $0.1) < ($1.0, $1.1) }.map { timestamp, _, point in
                var output: [String: JSONValue] = ["timestamp": .string(dates.formatter.string(from: timestamp))]
                let fields = version == 1 ? ["latitude", "longitude", "altitude"] : ["latitude", "longitude", "altitude", "course", "courseAccuracy", "horizontalAccuracy", "verticalAccuracy", "speed", "speedAccuracy"]
                for field in fields {
                    if let value = point[field] {
                        _ = try HEAValue.number(value, field)
                        let key = version == 1 ? ["latitude": "lat", "longitude": "lon"][field] ?? field : field
                        output[key] = value
                    }
                }
                // Preserve native negative CoreLocation sentinel values; never replace them with zero.
                return .object(output)
            })
        }
        if let series = payload["metrics"]?.object?["HKQuantityTypeIdentifierHeartRate"]?.object {
            guard let unit = series["unit"]?.text, let points = series["data"]?.array else { throw ConfigurationError("HEA 锻炼心率序列无效") }
            result["heartRateData"] = .array(try points.map { point in
                guard let point = point.object else { throw ConfigurationError("HEA 锻炼心率数据无效") }
                var output: [String: JSONValue] = ["date": .string(try dates.string(point["start"]?.text)), "units": .string(version == 1 ? "count" : "bpm")]
                if version == 1 {
                    output["qty"] = .number(try HEAValue.convert(HEAValue.number(point["average"], "average"), from: unit, to: "bpm"))
                } else {
                    for (native, hea) in [("minimum", "Min"), ("average", "Avg"), ("maximum", "Max")] {
                        if let value = point[native] { output[hea] = .number(try HEAValue.convert(HEAValue.number(value, native), from: unit, to: "bpm")) }
                    }
                    if let source = point["source"]?.text { output["source"] = .string(source) }
                }
                return .object(output)
            })
        }
        return .object(result)
    }

    private static func addMetadata(_ payload: [String: JSONValue], to result: inout [String: JSONValue]) throws {
        let metadata = payload["metadata"]?.object ?? [:]
        for (native, key, unit) in [
            ("HKElevationAscended", "elevationUp", "m"), ("HKElevationDescended", "elevationDown", "m"),
            ("HKWeatherTemperature", "temperature", "degC"), ("HKAverageMETs", "intensity", "MET"),
            ("HKLapLength", "lapLength", "m"), ("HKAverageSpeed", "avgSpeed", "kmph"), ("HKMaximumSpeed", "maxSpeed", "kmph")
        ] {
            if let value = metadata[native] { result[key] = try HEAValue.quantity(value, unit: unit) }
        }
        if let humidity = metadata["HKWeatherHumidity"] {
            let fraction = try HEAValue.quantity(humidity, unit: "%").object!["qty"]!.number!
            result["humidity"] = .object(["qty": .number(fraction * 100), "units": .string("%")])
        }
        if let stroke = metadata["HKSwimmingStrokeStyle"] {
            result["strokeStyle"] = .string(try HEAValue.enumName(stroke, [0: "Unknown", 1: "Mixed", 2: "Freestyle", 3: "Backstroke", 4: "Breaststroke", 5: "Butterfly", 6: "Kickboard"], "strokeStyle"))
        }
        if let salinity = metadata["HKMetadataKeyWaterSalinity"] {
            result["salinity"] = .string(try HEAValue.enumName(salinity, [1: "Fresh Water", 2: "Salt Water"], "salinity"))
        }
        if let swolf = metadata["HKSWOLFScore"] { result["swolfScore"] = .number(try HEAValue.number(swolf, "swolfScore")) }
        let configurations = (payload["activities"]?.array ?? []).compactMap { $0.object?["configuration"]?.object }
        // A top-level fallback is meaningful only when every activity agrees.
        func consensus(_ key: String) -> JSONValue? {
            guard let first = configurations.first?[key], configurations.allSatisfy({ $0[key] == first }) else { return nil }
            return first
        }
        if result["lapLength"] == nil, let lap = consensus("lapLength") { result["lapLength"] = try HEAValue.quantity(lap, unit: "m") }
        if let indoor = metadata["HKIndoorWorkout"] {
            guard case .bool = indoor else { throw ConfigurationError("HEA 室内锻炼标志无效") }; result["isIndoor"] = indoor
        } else if let location = consensus("locationType") {
            // HKWorkoutSessionLocationType starts at 1, unlike the swimming enum below.
            let name = try HEAValue.enumName(location, [1: "Unknown", 2: "Indoor", 3: "Outdoor"], "locationType")
            if name != "Unknown" { result["isIndoor"] = .bool(name == "Indoor") }
        }
        if let swimming = metadata["HKSwimmingLocationType"] ?? consensus("swimmingLocationType") {
            let name = try HEAValue.enumName(swimming, [0: "Unknown", 1: "Pool", 2: "Open Water"], "swimmingLocationType")
            if name != "Unknown" { result["location"] = .string(name) }
        }
        if result["location"] == nil, case .bool(let indoor) = result["isIndoor"] { result["location"] = .string(indoor ? "Indoor" : "Outdoor") }
        // Scalar custom metadata is documented. Preserve typed/nested metadata in native JSON only.
        let scalars = metadata.filter { _, value in
            switch value { case .string, .number, .bool: true; default: false }
        }
        if !scalars.isEmpty { result["metadata"] = .object(scalars) }
        // No inferred speed alias, cadence, or recovery series: their policies are undocumented.
    }

    private static func addSeries(_ payload: [String: JSONValue], to result: inout [String: JSONValue], dates: HEADates) throws {
        let metrics = payload["metrics"]?.object ?? [:]
        for (type, field, outputUnit) in [
            ("ActiveEnergyBurned", "activeEnergy", "kcal"), ("BasalEnergyBurned", "basalEnergy", "kcal"),
            ("CyclingCadence", "cyclingCadence", "rpm"), ("DistanceCycling", "cyclingDistance", "km"),
            ("CyclingPower", "cyclingPower", "W"), ("CyclingSpeed", "cyclingSpeed", "kmph"),
            ("DistanceSwimming", "swimDistance", "m"), ("SwimmingStrokeCount", "swimStroke", "count"),
            ("DistanceWalkingRunning", "walkingAndRunningDistance", "km"), ("StepCount", "stepCount", "count")
        ] {
            guard let series = metrics["HKQuantityTypeIdentifier" + type]?.object else { continue }
            guard let unit = series["unit"]?.text, let points = series["data"]?.array else { throw ConfigurationError("HEA 运动指标序列无效：\(type)") }
            result[field] = .array(try points.map { point in
                guard let point = point.object else { throw ConfigurationError("HEA 运动指标数据无效") }
                let number = try HEAValue.number(point["sum"] ?? point["average"], field)
                var output: [String: JSONValue] = ["date": .string(try dates.string(point["start"]?.text)), "qty": .number(try HEAValue.convert(number, from: unit, to: outputUnit)), "units": .string(outputUnit)]
                if let source = point["source"]?.text { output["source"] = .string(source) }
                return .object(output)
            })
        }
    }

}
