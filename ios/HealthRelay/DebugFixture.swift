#if DEBUG
import Foundation
import HealthRelayCore

struct DebugFixture: Decodable {
    var configuration: AutomationConfig
    var credentials: [String: String]
    @MainActor static func install(repository: ConfigurationRepository, credentials store: CredentialStore) throws -> AutomationConfig? {
        guard ProcessInfo.processInfo.arguments.contains("--load-acceptance-fixture") else { return nil }
        let file = URL.documentsDirectory.appendingPathComponent("acceptance-fixture.json")
        guard FileManager.default.fileExists(atPath: file.path) else { return nil }
        let fixture = try JSONDecoder().decode(Self.self, from: Data(contentsOf: file))
        var task = fixture.configuration
        task.enabled = false
        task.destination.headers = task.destination.headers.filter { !ConfigurationCodec.isSensitiveHeader($0.key) }
        task.destination.secretHeaders = [:]
        var references: [String] = []
        do {
            for (name, value) in fixture.credentials {
                let reference = try store.save(value); references.append(reference)
                task.destination.secretHeaders?[name] = reference
            }
            try repository.save([task])
            try FileManager.default.removeItem(at: file)
            return task
        } catch { for reference in references { store.delete(reference) }; throw error }
    }
}
#endif
