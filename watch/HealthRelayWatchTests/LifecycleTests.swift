import XCTest
import HealthRelayCore
@testable import HealthRelayWatch

@MainActor final class LifecycleTests: XCTestCase {
    func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }
    func testLaunchRegistersObserversBeforeAnyViewAppears() throws {
        let directory = try directory()
        var task = AutomationConfig.newTask(); task.device = .watch; task.enabled = true
        task.data.selections = [MetricSelection(typeIdentifier: "HKQuantityTypeIdentifierStepCount", unit: "count")]
        try ConfigurationRepository(fileURL: directory.appendingPathComponent("tasks.json")).save([task])
        let store = WatchStore(directory: directory, connectServices: false)
        let delegate = WatchAppDelegate(); delegate.store = store
        delegate.applicationDidFinishLaunching()
        XCTAssertEqual(store.installedObserverCount, 1)
    }
    func testHealthCallbackWaitsForBusyCoordinator() async throws {
        let store = WatchStore(directory: try directory(), connectServices: false)
        await store.coordinator.acquire()
        var completed = false
        let work = store.handleHealthChange("HKQuantityTypeIdentifierStepCount", completion: ObserverCompletion { completed = true })
        try await Task.sleep(for: .milliseconds(30))
        XCTAssertFalse(completed, "HealthKit callback must stay alive while processing waits for the coordinator")
        store.coordinator.release()
        await work.value
        XCTAssertTrue(completed)
    }
    func testUnreadableConfigurationReloadsAfterAccessReturns() async throws {
        let directory = try directory(), file = directory.appendingPathComponent("tasks.json")
        var task = AutomationConfig.newTask(); task.device = .watch
        try ConfigurationRepository(fileURL: file).save([task])
        try FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: file.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path) }
        XCTAssertThrowsError(try Data(contentsOf: file))
        let store = WatchStore(directory: directory, connectServices: false)
        XCTAssertNil(store.loadError, "Temporary file protection must not become permanent corruption")
        XCTAssertTrue(store.tasks.isEmpty)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        await store.start()
        XCTAssertEqual(store.tasks.map(\.id), [task.id])
        XCTAssertNil(store.loadError)
    }
    func testProtectedLaunchAndBackgroundRetryKeepFutureOpportunity() async throws {
        let directory = try directory(), file = directory.appendingPathComponent("tasks.json")
        try ConfigurationRepository(fileURL: file).save([AutomationConfig.newTask()])
        try FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: file.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path) }
        var requests: [Date] = []
        let started = Date()
        let store = WatchStore(directory: directory, connectServices: false, refreshScheduler: { requests.append($0) })
        let delegate = WatchAppDelegate(); delegate.store = store
        delegate.applicationDidFinishLaunching()
        XCTAssertEqual(requests.count, 1, "A protected cold launch still needs a recovery opportunity")
        await store.runDue(trigger: "background")
        XCTAssertEqual(requests.count, 2, "Consuming a refresh while locked must request the next one")
        XCTAssertTrue(requests.allSatisfy { $0.timeIntervalSince(started) >= 300 })
        XCTAssertEqual(store.installedObserverCount, 0)
    }
    func testCorruptConfigurationIsPreservedAndNotSubscribed() async throws {
        let directory = try directory(), file = directory.appendingPathComponent("tasks.json")
        let bytes = Data("invalid-json".utf8); try bytes.write(to: file)
        let store = WatchStore(directory: directory, connectServices: false)
        XCTAssertNotNil(store.loadError)
        await store.start()
        XCTAssertNotNil(store.loadError)
        XCTAssertEqual(store.installedObserverCount, 0)
        XCTAssertEqual(try Data(contentsOf: file), bytes)
    }
}
