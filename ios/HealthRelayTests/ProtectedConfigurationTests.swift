import XCTest
import HealthRelayCore
@testable import HealthRelay

@MainActor final class ProtectedConfigurationTests: XCTestCase {
    func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    func testUnavailableProtectedDataDefersLoadingWithoutCorruptError() throws {
        let dir = try directory()
        let task = AutomationConfig.newTask()
        try ConfigurationRepository(fileURL: dir.appendingPathComponent("tasks.json")).save([task])
        let store = AutomationStore(directory: dir, protectedDataAvailable: { false })
        XCTAssertTrue(store.tasks.isEmpty, "Protected configuration must not be loaded before data is available")
        XCTAssertNil(store.loadError)
    }

    func testDeferredConfigurationReloadsWhenProtectedDataBecomesAvailable() throws {
        let dir = try directory(), task = AutomationConfig.newTask()
        try ConfigurationRepository(fileURL: dir.appendingPathComponent("tasks.json")).save([task])
        var available = false
        let store = AutomationStore(directory: dir, protectedDataAvailable: { available })
        XCTAssertTrue(store.waitingForProtectedData)
        XCTAssertFalse(store.reloadProtectedConfiguration())
        available = true
        XCTAssertTrue(store.reloadProtectedConfiguration())
        XCTAssertEqual(store.tasks.map(\.id), [task.id])
        XCTAssertTrue(store.configurationReady)
        XCTAssertFalse(store.reloadProtectedConfiguration(), "Repeated notifications must not reload live state")
    }

    func testBackfillDecodeFailureDoesNotPublishPartialConfiguration() throws {
        let dir = try directory()
        try ConfigurationRepository(fileURL: dir.appendingPathComponent("tasks.json")).save([.newTask()])
        try Data("invalid-json".utf8).write(to: dir.appendingPathComponent("backfills.json"))
        let store = AutomationStore(directory: dir, protectedDataAvailable: { true })
        XCTAssertNotNil(store.loadError)
        XCTAssertTrue(store.tasks.isEmpty, "Tasks and backfills must load atomically")
    }

    func testCorruptConfigurationStaysAnErrorAndIsNotOverwritten() throws {
        let dir = try directory(), bytes = Data("invalid-json".utf8)
        let file = dir.appendingPathComponent("tasks.json")
        try bytes.write(to: file)
        let store = AutomationStore(directory: dir, protectedDataAvailable: { true })
        XCTAssertNotNil(store.loadError)
        XCTAssertFalse(store.reloadProtectedConfiguration())
        XCTAssertThrowsError(try store.save(.newTask()))
        XCTAssertEqual(try Data(contentsOf: file), bytes)
    }
}
