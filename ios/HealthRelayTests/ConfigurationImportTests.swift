import XCTest
import HealthRelayCore
@testable import HealthRelay

@MainActor final class ConfigurationImportTests: XCTestCase {
    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    private func task(_ name: String = "Import fixture") -> AutomationConfig {
        var task = AutomationConfig.newTask()
        task.name = name
        task.data.selections = [MetricSelection(typeIdentifier: "HKQuantityTypeIdentifierStepCount", unit: "count")]
        task.destination.url = "https://api.example.com/ingest"
        task.execution.onDataChange = false
        return task
    }

    func testBatchImportCreatesFreshDisabledCopiesAndPreservesExistingConfiguration() throws {
        let dir = try directory(), repository = ConfigurationRepository(fileURL: dir.appendingPathComponent("tasks.json"))
        var existing = task("Existing")
        existing.revision = 8; existing.enabled = true
        existing.destination.credentialRef = "synthetic-local-reference"
        existing.destination.credentialHeader = "Authorization"
        existing.destination.secretHeaders = ["X-API-Key": "synthetic-secret-reference"]
        try repository.save([existing])
        let store = AutomationStore(directory: dir, protectedDataAvailable: { true })
        var watch = task("Watch copy"); watch.device = .watch
        let report = ConfigurationExchange.inspect(try ConfigurationExchange.export([existing, watch]))
        XCTAssertTrue(report.valid)
        XCTAssertTrue(report.issues.contains { $0.code == "authentication_required" })
        try store.importConfigurations(report)
        XCTAssertEqual(store.tasks.count, 3)
        XCTAssertEqual(store.tasks[0], existing)
        let imported = Array(store.tasks.dropFirst())
        XCTAssertEqual(Set(store.tasks.map(\.id)).count, 3)
        XCTAssertFalse(imported.contains { [existing.id, watch.id].contains($0.id) })
        XCTAssertTrue(imported.allSatisfy { !$0.enabled && $0.revision == 1 })
        XCTAssertTrue(imported.allSatisfy { $0.destination.credentialRef == nil && $0.destination.secretHeaders == nil })
        XCTAssertEqual(imported.map(\.device), [.iPhone, .watch])
        XCTAssertEqual(try repository.load(), store.tasks)
    }

    func testMalformedAndErrorReportsNeverWrite() throws {
        let dir = try directory(), file = dir.appendingPathComponent("tasks.json")
        let existing = task()
        try ConfigurationRepository(fileURL: file).save([existing])
        let before = try Data(contentsOf: file)
        let store = AutomationStore(directory: dir, protectedDataAvailable: { true })
        var invalid = task(); invalid.destination.url = "invalid"
        for report in [ConfigurationExchange.inspect(Data("{".utf8)), ConfigurationExchange.inspect(try ConfigurationExchange.export([invalid]))] {
            XCTAssertFalse(report.valid)
            XCTAssertThrowsError(try store.importConfigurations(report))
            XCTAssertEqual(store.tasks, [existing])
            XCTAssertEqual(try Data(contentsOf: file), before)
        }
    }

    func testRepositoryFailureDoesNotPublishAnyImportedTask() throws {
        let dir = try directory(), file = dir.appendingPathComponent("tasks.json")
        let existing = task()
        try ConfigurationRepository(fileURL: file).save([existing])
        let store = AutomationStore(directory: dir, protectedDataAvailable: { true })
        try FileManager.default.removeItem(at: file)
        try FileManager.default.createDirectory(at: file, withIntermediateDirectories: false)
        let report = ConfigurationExchange.inspect(try ConfigurationExchange.export([task("A"), task("B")]))
        XCTAssertTrue(report.valid)
        XCTAssertThrowsError(try store.importConfigurations(report))
        XCTAssertEqual(store.tasks, [existing])
        var isDirectory: ObjCBool = false
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path, isDirectory: &isDirectory))
        XCTAssertTrue(isDirectory.boolValue)
    }

    func testProtectedConfigurationMustBeReadyBeforeImport() throws {
        let dir = try directory(), file = dir.appendingPathComponent("tasks.json")
        try ConfigurationRepository(fileURL: file).save([task()])
        let before = try Data(contentsOf: file)
        let store = AutomationStore(directory: dir, protectedDataAvailable: { false })
        XCTAssertFalse(store.configurationReady)
        let report = ConfigurationExchange.inspect(try ConfigurationExchange.export([task()]))
        XCTAssertThrowsError(try store.importConfigurations(report))
        XCTAssertTrue(store.tasks.isEmpty)
        XCTAssertEqual(try Data(contentsOf: file), before)
    }

    func testProtectedDataBecomingUnavailableBeforeImportDoesNotWrite() throws {
        let dir = try directory(), file = dir.appendingPathComponent("tasks.json")
        let existing = task()
        try ConfigurationRepository(fileURL: file).save([existing])
        let before = try Data(contentsOf: file)
        var available = true
        let store = AutomationStore(directory: dir, protectedDataAvailable: { available })
        XCTAssertTrue(store.configurationReady)
        available = false
        let report = ConfigurationExchange.inspect(try ConfigurationExchange.export([task("New")]))
        XCTAssertThrowsError(try store.importConfigurations(report))
        XCTAssertEqual(store.tasks, [existing])
        XCTAssertEqual(try Data(contentsOf: file), before)
    }

    func testCombinedWatchSnapshotLimitRejectsWholeBatch() throws {
        let dir = try directory(), file = dir.appendingPathComponent("tasks.json")
        var existing = task(); existing.device = .watch
        existing.destination.headers = ["X-Padding": String(repeating: "a", count: 40_000)]
        try ConfigurationRepository(fileURL: file).save([existing])
        let before = try Data(contentsOf: file)
        let store = AutomationStore(directory: dir, protectedDataAvailable: { true })
        var incoming = task(); incoming.device = .watch
        incoming.destination.headers = ["X-Padding": String(repeating: "b", count: 30_000)]
        let report = ConfigurationExchange.inspect(try ConfigurationExchange.export([task("Phone"), incoming]))
        XCTAssertTrue(report.valid)
        XCTAssertThrowsError(try store.importConfigurations(report))
        XCTAssertEqual(store.tasks, [existing])
        XCTAssertEqual(try Data(contentsOf: file), before)
    }
    func testHealthSignatureSetupPreservesExistingTaskAndStoresIndependentCredentials() throws {
        let dir = try directory(), file = dir.appendingPathComponent("tasks.json")
        let existing = task("Existing")
        try ConfigurationRepository(fileURL: file).save([existing])
        let store = AutomationStore(directory: dir, protectedDataAvailable: { true })
        try store.installHealthSignature(endpoint: "https://192.168.1.2:18443/ingest", key: "synthetic-test-key")
        XCTAssertEqual(store.tasks.first, existing)
        XCTAssertEqual(store.tasks.count, 3)
        let installed = Array(store.tasks.dropFirst())
        let references = installed.compactMap { $0.destination.secretHeaders?["X-Acceptance-Key"] }
        defer { for ref in references { store.credentials.delete(ref) } }
        XCTAssertEqual(Set(references).count, 2)
        for task in installed {
            XCTAssertFalse(task.enabled)
            XCTAssertTrue(task.executionIssues.isEmpty)
            XCTAssertNil(task.destination.requiredSecretHeaders)
        }
        XCTAssertEqual(try ConfigurationRepository(fileURL: file).load(), store.tasks)
        XCTAssertFalse(String(decoding: try Data(contentsOf: file), as: UTF8.self).contains("synthetic-test-key"))
    }

}
