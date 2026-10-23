import Foundation

/// Two independent native streams: health measurements and workout activity.
public enum HealthSignaturePreset {
    public static func watchConfigurations(endpoint: String) throws -> [AutomationConfig] {
        try configurations(endpoint: endpoint).map { task in
            var copy = task; copy.device = .watch; copy.name += " · Watch"
            let issues = copy.validationIssues(device: .watch)
            guard issues.isEmpty else { throw ConfigurationError(issues.joined(separator: "；")) }
            return copy
        }
    }
    public static func configurations(endpoint: String) throws -> [AutomationConfig] {
        var metrics = AutomationConfig.newTask()
        metrics.name = "健康签名 · 指标"
        metrics.range = DateRange(mode: .incremental, bootstrapDays: 30)
        metrics.data.family = .healthMetrics
        let ids = ["HKQuantityTypeIdentifierHeartRateVariabilityRMSSD", "HKQuantityTypeIdentifierHeartRate",
                   "HKQuantityTypeIdentifierRestingHeartRate", "HKCategoryTypeIdentifierSleepAnalysis",
                   "HKQuantityTypeIdentifierStepCount", "HKQuantityTypeIdentifierActiveEnergyBurned"]
        metrics.data.selections = try ids.map { id in
            guard let metric = MetricCatalog.bundled.metric(id) else { throw ConfigurationError("健康签名指标缺失") }
            return metric.selection
        }
        metrics.export.timeZone = "Asia/Shanghai"
        metrics.destination.url = endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        metrics.destination.acknowledgement = .receipt
        metrics.destination.requiredSecretHeaders = ["X-Acceptance-Key"]
        metrics.execution.periodicPolling = true
        metrics.execution.minimumIntervalSeconds = 300
        metrics.execution.notifyOnFailure = false
        metrics.execution.notifyOnSuccess = false
        var workouts = metrics
        workouts.id = UUID(); workouts.name = "健康签名 · 锻炼"
        workouts.data.family = .workout
        workouts.data.selections = [MetricSelection(typeIdentifier: "HKWorkoutType")]
        workouts.data.workoutOptions = WorkoutOptions()
        for task in [metrics, workouts] {
            let issues = task.validationIssues()
            guard issues.isEmpty else { throw ConfigurationError(issues.joined(separator: "；")) }
        }
        return [metrics, workouts]
    }
}
