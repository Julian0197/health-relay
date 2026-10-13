import Foundation

/// HEA 10.0.4 manual zh-CN health-metrics CSV header order and fixed display units.
/// Header evidence does not establish REST transport or unsupported category row semantics.
enum HEACSVProfile {
    struct Column {
        let typeIdentifier: String
        let header: String
        let unit: String
        let field: String
        init(_ suffix: String, _ header: String, _ unit: String, _ field: String = "value") {
            typeIdentifier = (suffix == "SleepAnalysis" ? "HKCategoryTypeIdentifier" : "HKQuantityTypeIdentifier") + suffix
            self.header = header; self.unit = unit; self.field = field
        }
    }
    static let columns: [Column] = [
        Column("AppleMoveTime", "Apple 活动时间 (分钟)", "min"),
        Column("AppleSleepingWristTemperature", "Apple 睡眠手腕温度 (ºC)", "degC"),
        Column("AppleStandTime", "Apple 站立时间 (分钟)", "min"),
        Column("AppleExerciseTime", "Apple锻炼时间 (分钟)", "min"),
        Column("StairDescentSpeed", "下楼梯速度 (米/秒)", "m/s"),
        Column("BodyTemperature", "体温 (ºC)", "degC"),
        Column("BodyFatPercentage", "体脂百分比 (%)", "%"),
        Column("BodyMass", "体重 (千克)", "kg"),
        Column("SixMinuteWalkTestDistance", "六分钟步行测试距离 (m)", "m"),
        Column("DietaryFatMonounsaturated", "单不饱和脂肪 (克)", "g"),
        Column("LeanBodyMass", "去脂体重 (千克)", "kg"),
        Column("DietaryFolate", "叶酸 (微克)", "mcg"),
        Column("InhalerUsage", "吸入器使用 (计数)", "count"),
        Column("AppleSleepingBreathingDisturbances", "呼吸障碍 (计数)", "count"),
        Column("RespiratoryRate", "呼吸频率 (count/min)", "count/min"),
        Column("DietaryCaffeine", "咖啡因 (mg)", "mg"),
        Column("BasalBodyTemperature", "基础体温 (ºC)", "degC"),
        Column("PeripheralPerfusionIndex", "外周灌注指数 (%)", "%"),
        Column("DietaryFatPolyunsaturated", "多不饱和脂肪 (克)", "g"),
        Column("PeakExpiratoryFlowRate", "峰值呼气流量 (L/分)", "L/min"),
        Column("HeartRate", "心率 [最小值] (bpm)", "bpm", "minimum"),
        Column("HeartRate", "心率 [最大] (bpm)", "bpm", "maximum"),
        Column("HeartRate", "心率 [平均值] (bpm)", "bpm", "average"),
        Column("HeartRateVariabilitySDNN", "心率变异性 (ms)", "ms"),
        Column("HeartRateRecoveryOneMinute", "心肺恢复 (count/min)", "count/min"),
        Column("DietaryFatTotal", "总脂肪 (克)", "g"),
        Column("AtrialFibrillationBurden", "房颤负荷 (%)", "%"),
        Column("PushCount", "推动次数 (计数)", "count"),
        Column("FlightsClimbed", "攀登楼层数 (计数)", "count"),
        Column("TimeInDaylight", "日照时长 (分钟)", "min"),
        Column("VO2Max", "最大摄氧量（VO2 Max） (ml/(kg·min))", "mL/(kg*min)"),
        Column("DietaryRiboflavin", "核黄素 (mg)", "mg"),
        Column("WalkingStepLength", "步幅长度 (cm)", "cm"),
        Column("RunningStrideLength", "步幅长度 (m)", "m"),
        Column("StepCount", "步数 (步)", "count"),
        Column("DistanceWalkingRunning", "步行 + 跑步距离 (km)", "km"),
        Column("WalkingAsymmetryPercentage", "步行不对称百分比 (%)", "%"),
        Column("WalkingDoubleSupportPercentage", "步行双支撑百分比 (%)", "%"),
        Column("WalkingHeartRateAverage", "步行心率均值 (bpm)", "bpm"),
        Column("WalkingSpeed", "步行速度 (公里/小时)", "km/hr"),
        Column("DietaryChloride", "氯化物 (mg)", "mg"),
        Column("WaterTemperature", "水下体温 (ºC)", "degC"),
        Column("UnderwaterDepth", "水下深度 (m)", "m"),
        Column("DietaryPantothenicAcid", "泛酸 (mg)", "mg"),
        Column("ActiveEnergyBurned", "活动能量 (kJ)", "kJ"),
        Column("SwimmingStrokeCount", "游泳划水次数 (划水次数)", "count"),
        Column("DistanceSwimming", "游泳距离 (m)", "m"),
        Column("DietaryNiacin", "烟酸 (mg)", "mg"),
        Column("StairAscentSpeed", "爬楼速度：上 (米/秒)", "m/s"),
        Column("EnvironmentalAudioExposure", "环境音频暴露 (dBASPL)", "dBASPL"),
        Column("DietaryBiotin", "生物素 (微克)", "mcg"),
        Column("ForcedVitalCapacity", "用力肺活量 (L)", "L"),
        Column("ElectrodermalActivity", "皮肤电活动 (mcS)", "mcS"),
        Column("SleepAnalysis", "睡眠分析 [Total] (小时)", "hr", "totalSleep"),
        Column("SleepAnalysis", "睡眠分析 [睡眠时长] (小时)", "hr", "asleep"),
        Column("SleepAnalysis", "睡眠分析 [在床上] (小时)", "hr", "inBed"),
        Column("SleepAnalysis", "睡眠分析 [核心] (小时)", "hr", "core"),
        Column("SleepAnalysis", "睡眠分析 [深度] (小时)", "hr", "deep"),
        Column("SleepAnalysis", "睡眠分析 [快速动眼期] (小时)", "hr", "rem"),
        Column("SleepAnalysis", "睡眠分析 [清醒] (小时)", "hr", "awake"),
        Column("DietarySelenium", "硒 (微克)", "mcg"),
        Column("DietaryThiamin", "硫胺素 (mg)", "mg"),
        Column("DietaryIodine", "碘 (微克)", "mcg"),
        Column("DietaryCarbohydrates", "碳水化合物 (克)", "g"),
        Column("DietaryPhosphorus", "磷 (mg)", "mg"),
        Column("ForcedExpiratoryVolume1", "第一秒用力呼气量 (L)", "L"),
        Column("DietarySugar", "糖 (克)", "g"),
        Column("UVExposure", "紫外线暴露 (计数)", "count"),
        Column("DietaryVitaminB12", "维生素 B12 (微克)", "mcg"),
        Column("DietaryVitaminC", "维生素 C (mg)", "mg"),
        Column("DietaryVitaminD", "维生素 D (微克)", "mcg"),
        Column("DietaryVitaminE", "维生素 E (mg)", "mg"),
        Column("DietaryVitaminA", "维生素A (微克)", "mcg"),
        Column("DietaryVitaminB6", "维生素B6 (mg)", "mg"),
        Column("DietaryVitaminK", "维生素K (微克)", "mcg"),
        Column("HeadphoneAudioExposure", "耳机音频暴露 (dBASPL)", "dBASPL"),
        Column("DietaryCholesterol", "胆固醇 (mg)", "mg"),
        Column("InsulinDelivery", "胰岛素输注 (国际单位)", "IU"),
        Column("WaistCircumference", "腰围 (cm)", "cm"),
        Column("DietaryFiber", "膳食纤维 (克)", "g"),
        Column("DietaryEnergyConsumed", "膳食能量 (kJ)", "kJ"),
        Column("DietaryProtein", "蛋白质 (克)", "g"),
        Column("OxygenSaturation", "血氧饱和度 (%)", "%"),
        Column("BloodAlcoholContent", "血液酒精含量 (%)", "%"),
        Column("BloodGlucose", "血糖 (mmol/L)", "mmol/L"),
        Column("NumberOfTimesFallen", "跌倒次数 (次)", "count"),
        Column("RunningPower", "跑步功率 (瓦特)", "W"),
        Column("RunningVerticalOscillation", "跑步垂直振幅 (cm)", "cm"),
        Column("RunningGroundContactTime", "跑步接地时间 (ms)", "ms"),
        Column("RunningSpeed", "跑步速度 (公里/小时)", "km/hr"),
        Column("PhysicalEffort", "身体努力 (kcal/hr·kg)", "kcal/(hr*kg)"),
        Column("BodyMassIndex", "身体质量指数 (计数)", "count"),
        Column("Height", "身高 (m)", "m"),
        Column("DistanceWheelchair", "轮椅距离 (km)", "km"),
        Column("NumberOfAlcoholicBeverages", "酒精摄入 (计数)", "count"),
        Column("DietaryCalcium", "钙 (mg)", "mg"),
        Column("DietarySodium", "钠 (mg)", "mg"),
        Column("DietaryMolybdenum", "钼 (微克)", "mcg"),
        Column("DietaryPotassium", "钾 (mg)", "mg"),
        Column("DietaryIron", "铁 (mg)", "mg"),
        Column("DietaryCopper", "铜 (mg)", "mg"),
        Column("DietaryChromium", "铬 (微克)", "mcg"),
        Column("DietaryZinc", "锌 (mg)", "mg"),
        Column("DietaryManganese", "锰 (mg)", "mg"),
        Column("DietaryMagnesium", "镁 (mg)", "mg"),
        Column("RestingHeartRate", "静息心率 (bpm)", "bpm"),
        Column("BasalEnergyBurned", "静息能量 (kJ)", "kJ"),
        Column("DietaryWater", "饮水 (mL)", "mL"),
        Column("DietaryFatSaturated", "饱和脂肪 (克)", "g"),
        Column("CyclingPower", "骑行功率 (瓦特)", "W"),
        Column("CyclingFunctionalThresholdPower", "骑行功能性阈值功率 (瓦特)", "W"),
        Column("DistanceCycling", "骑行距离 (km)", "km"),
        Column("CyclingCadence", "骑行踏频 (count/min)", "count/min"),
        Column("CyclingSpeed", "骑行速度 (公里/小时)", "km/hr"),
        Column("DistanceDownhillSnowSports", "高山雪上运动距离 (km)", "km"),
    ]
    static let supportedTypes = Set(columns.map(\.typeIdentifier))

    /// CSV-only conversions preserve the existing JSON projection and its unit policy.
    static func convert(_ value: Double, from: String, to: String) throws -> Double {
        guard value.isFinite else { throw ConfigurationError("HEA CSV 数值无效") }
        let scales: [[String: Double]] = [
            ["kcal": 4184, "kJ": 1000, "J": 1],
            ["kg": 1000, "lb": 453.59237, "g": 1, "mg": 0.001, "mcg": 0.000001],
            ["L": 1000, "mL": 1], ["S": 1000000, "mcS": 1],
            // Matches HealthKit HKUnitMolarMassBloodGlucose (180.15588000005408 g/mol).
            ["mg/dL": 1, "mmol/L": 18.015588000005408]
        ]
        let converted: Double
        if from == to { converted = value }
        else if let scale = scales.first(where: { $0[from] != nil && $0[to] != nil }) {
            converted = value * scale[from]! / scale[to]!
        } else { converted = try HEAValue.convert(value, from: from, to: to) }
        let result = to == "%" ? converted * 100 : converted
        guard result.isFinite else { throw ConfigurationError("HEA CSV 单位换算结果无效") }
        return result
    }
}
