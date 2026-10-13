#if DEBUG && targetEnvironment(simulator)
import Foundation
import HealthRelayCore

/// Opt-in synthetic-only acceptance. This type is absent from device/Release builds.
struct WatchAcceptanceFixture: Decodable {
    var configuration: AutomationConfig
    var credentials: [String: String]
    static var active: Bool { ProcessInfo.processInfo.arguments.contains("--watch-synthetic-acceptance") }
    static func validate(_ task: AutomationConfig) throws {
        guard let url = URL(string: task.destination.url), url.scheme == "https",
              let host = url.host, host.hasPrefix("healthrelay-acceptance."), host.hasSuffix(".workers.dev"), url.path == "/ingest",
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else { throw ConfigurationError("仅允许隔离验收 Worker") }
    }
    @MainActor static func install(repository: ConfigurationRepository, credentials store: CredentialStore) throws -> AutomationConfig? {
        guard active else { return nil }
        let file = URL.documentsDirectory.appendingPathComponent("acceptance-fixture.json")
        guard FileManager.default.fileExists(atPath: file.path) else { return nil }
        let fixture = try JSONDecoder().decode(Self.self, from: Data(contentsOf: file))
        var task = fixture.configuration
        try validate(task)
        task.device = .watch; task.enabled = true
        task.execution.onDataChange = false; task.execution.periodicPolling = false; task.execution.onForeground = true
        task.destination.headers = task.destination.headers.filter { !ConfigurationCodec.isSensitiveHeader($0.key) }
        task.destination.credentialRef = nil; task.destination.credentialHeader = nil
        task.destination.secretHeaders = [:]; task.destination.requiredSecretHeaders = nil
        var created: [String] = []
        do {
            for (name, value) in fixture.credentials {
                guard AutomationConfig.isValidHeaderName(name), !AutomationConfig.containsHeaderLineBreak(value), !["host", "content-type", "content-length", "idempotency-key"].contains(name.lowercased()) else { throw ConfigurationError("验收 Header 无效") }
                let reference = try store.save(value); created.append(reference)
                task.destination.secretHeaders?[name] = reference
            }
            guard (task.validationIssues(systemMajorVersion: 27, device: .watch) + task.executionIssues).isEmpty else { throw ConfigurationError("验收配置无效") }
            try repository.save([task])
            try FileManager.default.removeItem(at: file)
            return task
        } catch { for reference in created { store.delete(reference) }; throw error }
    }
}
#endif
