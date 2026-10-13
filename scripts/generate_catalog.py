#!/usr/bin/env python3
"""Generate configuration metadata from the locally installed public iOS SDK."""
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SDK = Path(subprocess.check_output(["xcrun", "--sdk", "iphoneos", "--show-sdk-path"], text=True).strip())
HEADER = SDK / "System/Library/Frameworks/HealthKit.framework/Headers/HKTypeIdentifiers.h"

TITLES = {
    "BodyMass": "体重", "BodyMassIndex": "身体质量指数", "BodyFatPercentage": "体脂率",
    "Height": "身高", "WaistCircumference": "腰围", "LeanBodyMass": "瘦体重",
    "ElectrodermalActivity": "皮肤电活动", "AppleSleepingWristTemperature": "睡眠手腕温度",
    "HeartRate": "心率", "RestingHeartRate": "静息心率", "WalkingHeartRateAverage": "步行平均心率",
    "HeartRateVariabilitySDNN": "心率变异性（SDNN）", "HeartRateVariabilityRMSSD": "恢复 HRV（RMSSD）",
    "HeartRateRecoveryOneMinute": "一分钟心率恢复", "AtrialFibrillationBurden": "房颤负荷",
    "BloodPressureSystolic": "收缩压", "BloodPressureDiastolic": "舒张压", "BloodPressure": "血压",
    "OxygenSaturation": "血氧饱和度", "RespiratoryRate": "呼吸频率", "BodyTemperature": "体温",
    "BasalBodyTemperature": "基础体温", "BloodGlucose": "血糖", "InsulinDelivery": "胰岛素给药",
    "StepCount": "步数", "FlightsClimbed": "爬楼层数", "ActiveEnergyBurned": "活动能量",
    "BasalEnergyBurned": "静息能量", "AppleExerciseTime": "锻炼时间", "AppleMoveTime": "活动时间",
    "AppleStandTime": "站立时间", "AppleStandHour": "站立小时", "VO2Max": "最大摄氧量",
    "DistanceWalkingRunning": "步行与跑步距离", "DistanceCycling": "骑行距离", "DistanceSwimming": "游泳距离",
    "DistanceWheelchair": "轮椅距离", "PushCount": "轮椅推动次数", "SwimmingStrokeCount": "游泳划水次数",
    "CyclingCadence": "骑行踏频", "CyclingPower": "骑行功率", "CyclingSpeed": "骑行速度",
    "CyclingFunctionalThresholdPower": "骑行功能阈值功率", "RunningPower": "跑步功率",
    "RunningSpeed": "跑步速度", "RunningStrideLength": "跑步步幅", "RunningGroundContactTime": "跑步触地时间",
    "RunningVerticalOscillation": "跑步垂直振幅", "WalkingSpeed": "步行速度", "WalkingStepLength": "步长",
    "WalkingAsymmetryPercentage": "步行不对称性", "WalkingDoubleSupportPercentage": "步行双支撑时间比例",
    "SixMinuteWalkTestDistance": "六分钟步行距离", "StairAscentSpeed": "上楼速度", "StairDescentSpeed": "下楼速度",
    "AppleWalkingSteadiness": "步行稳定性", "PhysicalEffort": "体能努力", "WorkoutEffortScore": "锻炼努力评分",
    "EstimatedWorkoutEffortScore": "估计锻炼努力评分", "SleepAnalysis": "睡眠阶段",
    "AppleSleepingBreathingDisturbances": "睡眠呼吸紊乱", "SleepDurationGoal": "睡眠时长目标",
    "EnvironmentalAudioExposure": "环境音量", "HeadphoneAudioExposure": "耳机音量",
    "UnderwaterDepth": "水下深度", "WaterTemperature": "水温", "UVExposure": "紫外线照射",
    "MindfulSession": "正念训练", "SexualActivity": "性活动", "MenstrualFlow": "经期流量",
    "IntermenstrualBleeding": "经期间出血", "CervicalMucusQuality": "宫颈黏液质量",
    "OvulationTestResult": "排卵测试结果", "Pregnancy": "怀孕", "Lactation": "哺乳",
    "PregnancyTestResult": "妊娠测试结果", "ProgesteroneTestResult": "孕酮测试结果",
    "HighHeartRateEvent": "高心率通知", "LowHeartRateEvent": "低心率通知",
    "IrregularHeartRhythmEvent": "心律不齐通知", "Food": "饮食关联记录",
    "ForcedExpiratoryVolume1": "一秒用力呼气量", "ForcedVitalCapacity": "用力肺活量",
    "PeakExpiratoryFlowRate": "呼气峰值流速", "PeripheralPerfusionIndex": "末梢灌注指数",
    "InhalerUsage": "吸入器使用", "NumberOfTimesFallen": "跌倒次数",
    "AbdominalCramps": "腹部痉挛", "Acne": "痤疮", "AppetiteChanges": "食欲变化", "BladderIncontinence": "尿失禁",
    "Bloating": "腹胀", "BreastPain": "乳房疼痛", "ChestTightnessOrPain": "胸闷或胸痛",
    "Chills": "发冷", "Constipation": "便秘", "Coughing": "咳嗽", "Diarrhea": "腹泻",
    "Dizziness": "头晕", "DrySkin": "皮肤干燥", "Fainting": "昏厥", "Fatigue": "疲劳",
    "Fever": "发热", "GeneralizedBodyAche": "全身疼痛", "HairLoss": "脱发", "Headache": "头痛",
    "Heartburn": "胃灼热", "HotFlashes": "潮热", "LossOfSmell": "嗅觉丧失", "LossOfTaste": "味觉丧失",
    "LowerBackPain": "腰痛", "MemoryLapse": "记忆力减退", "MoodChanges": "情绪变化", "Nausea": "恶心",
    "NightSweats": "盗汗", "PelvicPain": "盆腔疼痛", "RapidPoundingOrFlutteringHeartbeat": "心跳加速或心悸",
    "RunnyNose": "流鼻涕", "ShortnessOfBreath": "气短", "SinusCongestion": "鼻窦堵塞",
    "SkippedHeartbeat": "心跳漏拍", "SleepChanges": "睡眠变化", "SoreThroat": "喉咙痛",
    "VaginalDryness": "阴道干涩", "Vomiting": "呕吐", "Wheezing": "喘息",
    "ToothbrushingEvent": "刷牙", "HandwashingEvent": "洗手",
}

NUTRIENTS = {
    "EnergyConsumed": "能量摄入", "Water": "水", "Caffeine": "咖啡因", "Protein": "蛋白质",
    "Carbohydrates": "碳水化合物", "Fiber": "膳食纤维", "Sugar": "糖", "FatTotal": "总脂肪",
    "FatSaturated": "饱和脂肪", "FatMonounsaturated": "单不饱和脂肪", "FatPolyunsaturated": "多不饱和脂肪",
    "Cholesterol": "胆固醇", "Sodium": "钠", "Potassium": "钾", "Calcium": "钙", "Iron": "铁",
    "Magnesium": "镁", "Zinc": "锌", "Copper": "铜", "Manganese": "锰", "Selenium": "硒",
    "Phosphorus": "磷", "Chloride": "氯", "Iodine": "碘", "Chromium": "铬", "Molybdenum": "钼",
    "VitaminA": "维生素 A", "VitaminB6": "维生素 B6", "VitaminB12": "维生素 B12",
    "VitaminC": "维生素 C", "VitaminD": "维生素 D", "VitaminE": "维生素 E", "VitaminK": "维生素 K",
    "Thiamin": "硫胺素", "Riboflavin": "核黄素", "Niacin": "烟酸", "Folate": "叶酸",
    "Biotin": "生物素", "PantothenicAcid": "泛酸",
}

CATEGORIES = {
    "Body Measurements": "身体测量", "Fitness": "活动与运动", "Vitals": "生命体征",
    "Lab and Test Results": "检测结果", "Nutrition": "营养", "Mobility": "活动能力",
    "Hearing": "听力", "Heart": "心脏", "Respiratory": "呼吸系统",
    "Reproductive Health": "生殖健康", "Other": "其他",
}

UNIT_OPTIONS = {
    "kg": ["kg", "lb"], "g": ["g", "mg", "mcg"], "m": ["m", "km", "mi", "cm"],
    "degC": ["degC", "degF"], "kcal": ["kcal", "kJ"], "min": ["min", "hr", "s"],
    "L": ["L", "mL"], "mL": ["mL", "L"], "m/s": ["m/s", "km/hr", "mi/hr"],
    "ms": ["ms", "s"], "mmHg": ["mmHg", "kPa"], "count/min": ["count/min", "count/s"],
    "count/s": ["count/min", "count/s"]
}

metrics = []
category = "其他"
pattern = re.compile(r"HK_EXTERN\s+HK(Quantity|Category|Correlation)TypeIdentifier\s+const\s+(HK\w+)\s+([^;]*);(?:\s*//\s*(.*))?")
for line in HEADER.read_text().splitlines():
    section = re.fullmatch(r"\s*//\s*([\w /&+-]+)\s*", line)
    if section and section.group(1) in CATEGORIES:
        category = CATEGORIES[section.group(1)]
    match = pattern.search(line)
    if not match:
        continue
    family, symbol, declaration, comment = match.groups()
    family = family.lower()
    suffix = re.sub(r"^HK(?:Quantity|Category|Correlation)TypeIdentifier", "", symbol)
    introduced = re.search(r"API_AVAILABLE\([^;]*?\bios\((\d+)", declaration)
    minimum_ios = int(introduced.group(1)) if introduced else 8
    title = TITLES.get(suffix, re.sub(r"(?<=[a-z])(?=[A-Z])", " ", suffix))
    item_category = category if family == "quantity" else "分类记录"
    if suffix.startswith("Dietary"):
        nutrient = suffix[len("Dietary"):]
        title = "营养 · " + NUTRIENTS.get(nutrient, nutrient)
        item_category = "营养"
    elif suffix in ["HeartRate", "RestingHeartRate", "WalkingHeartRateAverage", "AtrialFibrillationBurden"] or "HeartRate" in suffix or "BloodPressure" in suffix:
        item_category = "心脏"
    elif "Sleep" in suffix:
        item_category = "睡眠"
    unit = (comment or "").split(",")[0].strip() if family == "quantity" else ""
    unit = {"ml/(kg*min)": "mL/(kg*min)"}.get(unit, unit)
    if not unit or " " in unit or "(" in unit:
        # Unit metadata requires an explicit mapping, never guessed from a metric name.
        explicit = {"VO2Max": "mL/(kg*min)", "BloodGlucose": "mg/dL", "PhysicalEffort": "kcal/(hr*kg)",
                    "UVExposure": "count", "AppleSleepingBreathingDisturbances": "count"}
        if family == "quantity":
            unit = explicit[suffix]
    statistics = []
    if family == "quantity":
        statistics = ["sum"] if "Cumulative" in (comment or "") else ["average", "minimum", "maximum"]
        if "EquivalentContinuousLevel" in (comment or ""):
            statistics = []
    metrics.append({
        "id": symbol, "title": title, "category": item_category, "family": family,
        "minimumIOS": minimum_ios,
        "minimumWatchOS": int(re.search(r"\bwatchos\((\d+)", declaration).group(1)) if re.search(r"\bwatchos\((\d+)", declaration) else None, "units": UNIT_OPTIONS.get(unit, [unit]) if family == "quantity" else [],
        "statistics": statistics,
    })

metrics.append({"id": "HKWorkoutType", "title": "锻炼记录", "category": "活动与运动", "family": "workout", "minimumIOS": 8, "minimumWatchOS": 2, "units": [], "statistics": []})
for identifier, title, category, ios, watch in [
    ("HKDataTypeIdentifierElectrocardiogram", "心电图", "心脏", 14, 7),
    ("HKDataTypeStateOfMind", "心境", "心理健康", 18, 11),
    ("HKMedicationDoseEventTypeIdentifierMedicationDoseEvent", "用药记录", "用药", 26, 26),
]:
    metrics.append({"id": identifier, "title": title, "category": category, "family": "special",
                    "minimumIOS": ios, "minimumWatchOS": watch, "units": [], "statistics": []})
assert sum(m["family"] == "quantity" for m in metrics) == 121
assert sum(m["family"] == "category" for m in metrics) == 72
output = ROOT / "packages/HealthRelayCore/Sources/HealthRelayCore/Resources/catalog.json"
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps({"metrics": metrics}, ensure_ascii=False, indent=2) + "\n")
print(f"Generated {len(metrics)} configuration descriptors at {output.relative_to(ROOT)}")
