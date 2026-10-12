import Foundation
import Observation
import Security
import HealthRelayCore

@MainActor @Observable
final class AutomationStore {
    private(set) var tasks: [AutomationConfig] = []
    private(set) var loadError: String?
    private let repository: ConfigurationRepository
    let credentials = CredentialStore()

    init() {
        let testing = ProcessInfo.processInfo.arguments.contains("--ui-testing")
        let directory = URL.applicationSupportDirectory.appendingPathComponent(testing ? "HealthRelay-UITests" : "HealthRelay", isDirectory: true)
        let file = directory.appendingPathComponent("tasks.json")
        if testing && ProcessInfo.processInfo.arguments.contains("--reset-configurations") {
            try? FileManager.default.removeItem(at: directory)
        }
        repository = ConfigurationRepository(fileURL: file)
        do { tasks = try repository.load() }
        catch { loadError = error.localizedDescription }
    }

    func save(_ task: AutomationConfig) throws {
        guard loadError == nil else { throw ConfigurationError("本地配置未能读取，保存已停止以保护原文件") }
        var updated = tasks
        var candidate = task
        if let index = updated.firstIndex(where: { $0.id == task.id }) {
            candidate.revision = updated[index].revision + 1
            updated[index] = candidate
        } else { updated.append(candidate) }
        try repository.save(updated)
        tasks = updated
    }

    func delete(_ task: AutomationConfig) throws {
        guard loadError == nil else { throw ConfigurationError("本地配置未能读取") }
        let updated = tasks.filter { $0.id != task.id }
        try repository.save(updated)
        tasks = updated
        removeCredentials(task)
    }

    func removeCredentials(_ task: AutomationConfig) {
        if let ref = task.destination.credentialRef { credentials.delete(ref) }
        for ref in task.destination.secretHeaders?.values ?? Dictionary<String, String>().values { credentials.delete(ref) }
    }
}

struct CredentialStore {
    private let service = "org.healthrelay.automation-credentials"
    func save(_ value: String) throws -> String {
        let reference = UUID().uuidString
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: reference,
            kSecValueData as String: Data(value.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        ]
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw ConfigurationError("认证信息保存失败（\(status)）") }
        return reference
    }
    func delete(_ reference: String) {
        SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: reference
        ] as CFDictionary)
    }
}
