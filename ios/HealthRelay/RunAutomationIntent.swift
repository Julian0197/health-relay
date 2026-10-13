import AppIntents
import HealthRelayCore

struct AutomationTaskEntity: AppEntity {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "健康导出任务"
    static let defaultQuery = AutomationTaskQuery()
    var id: String
    var name: String
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
}
struct AutomationTaskQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [AutomationTaskEntity] {
        await MainActor.run {
            AutomationStore.shared.tasks.filter { identifiers.contains($0.id.uuidString) }
                .map { AutomationTaskEntity(id: $0.id.uuidString, name: $0.name) }
        }
    }
    func suggestedEntities() async throws -> [AutomationTaskEntity] {
        await MainActor.run { AutomationStore.shared.tasks.map { AutomationTaskEntity(id: $0.id.uuidString, name: $0.name) } }
    }
}
struct RunAutomationIntent: AppIntent {
    static let title: LocalizedStringResource = "运行健康导出"
    static let description = IntentDescription("读取指定任务的健康数据，重试待上传批次并上传新记录。")
    static let openAppWhenRun = false
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    @Parameter(title: "任务") var task: AutomationTaskEntity
    static var parameterSummary: some ParameterSummary { Summary("运行 \(\.$task)") }
    @MainActor func perform() async throws -> some IntentResult & ReturnsValue<String> {
        let store = AutomationStore.shared
        guard let configuration = store.tasks.first(where: { $0.id.uuidString == task.id }) else { throw ConfigurationError("任务不存在") }
        guard configuration.enabled else { throw ConfigurationError("任务已关闭，请先在 App 中启用") }
        guard !store.active.contains(configuration.id) else { throw ConfigurationError("任务正在运行，请稍后重试") }
        // Permissions must be granted in the app before unattended execution.
        await store.run(configuration, automatic: true, trigger: "shortcut")
        guard let result = store.outcomes[configuration.id] else { throw ConfigurationError("任务未能运行") }
        if result.state == .failed { throw ConfigurationError(result.message) }
        return .result(value: result.message)
    }
}
struct HealthRelayShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: RunAutomationIntent(), phrases: ["用 \(.applicationName) 运行健康导出"], shortTitle: "运行健康导出", systemImageName: "arrow.up.doc")
    }
}
