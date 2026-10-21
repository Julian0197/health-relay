import XCTest
import HealthRelayCore
@testable import HealthRelayWatch

@MainActor final class LifecycleTests: XCTestCase {
    func testBackgroundCompletionAddsTimeWithoutBreakingOldResultsOrIdentityDescriptions() throws {
        let identity = BatchIdentity(taskID: UUID(), batchID: "batch", fingerprint: "fingerprint")
        let at = Date(timeIntervalSince1970: 1_792_550_000)
        let description = UploadAttemptDescription(identity: identity, attemptID: "attempt", startedAt: at)
        let text = String(decoding: try JSONEncoder().encode(description), as: UTF8.self)
        XCTAssertEqual(BatchIdentity.decodeDescription(text), identity)
        var completion = UploadCompletion(identity: identity, status: 200, body: Data(), retryable: true)
        completion.completedAt = at; completion.completionID = "completion"; completion.attemptID = "attempt"
        let decoded = try JSONDecoder().decode(UploadCompletion.self, from: JSONEncoder().encode(completion))
        XCTAssertEqual(decoded.completedAt, at)
        XCTAssertEqual(decoded.attemptID, "attempt")
        var legacy = try JSONSerialization.jsonObject(with: JSONEncoder().encode(completion)) as! [String: Any]
        legacy.removeValue(forKey: "completedAt"); legacy.removeValue(forKey: "completionID"); legacy.removeValue(forKey: "attemptID")
        let old = try JSONDecoder().decode(UploadCompletion.self, from: JSONSerialization.data(withJSONObject: legacy))
        XCTAssertNil(old.completedAt); XCTAssertEqual(old.identity, identity)
    }
    func testWatchStartupImportsLocalLegacyHistoryWithoutChangingTasks() throws {
        let directory = try directory()
        var task = AutomationConfig.newTask(); task.device = .watch
        try ConfigurationRepository(fileURL: directory.appendingPathComponent("tasks.json")).save([task])
        let journal = SyncJournal(directory: directory.appendingPathComponent("sync"))
        var state = SyncState(); state.logs = [RunLog(state: .succeeded, message: "旧记录", records: 2)]
        try journal.save(state, for: task.id)
        let store = WatchStore(directory: directory, connectServices: false)
        XCTAssertEqual(store.tasks, [task])
        XCTAssertEqual(try store.history.page().entries.count, 1)
        XCTAssertEqual(try store.history.page().entries[0].summary.recordCount, 2)
    }
    func testSignatureSetupPreservesTasksAndKeepsAuthenticationInWatchKeychain() async throws {
        let directory = try directory()
        var old = AutomationConfig.newTask(); old.device = .watch
        try ConfigurationRepository(fileURL: directory.appendingPathComponent("tasks.json")).save([old])
        let store = WatchStore(directory: directory, connectServices: false)
        try await store.installHealthSignature(endpoint: "https://example.com/ingest", key: "synthetic-watch-token")
        XCTAssertEqual(store.tasks.count, 3)
        XCTAssertEqual(store.tasks.first, old)
        let installed = Array(store.tasks.dropFirst())
        let refs = installed.compactMap { $0.destination.secretHeaders?["X-Acceptance-Key"] }
        defer { for ref in refs { CredentialStore().delete(ref) } }
        XCTAssertEqual(Set(refs).count, 2)
        XCTAssertTrue(installed.allSatisfy { $0.device == .watch && !$0.enabled && $0.executionIssues.isEmpty })
        let saved = try Data(contentsOf: directory.appendingPathComponent("tasks.json"))
        XCTAssertFalse(String(decoding: saved, as: UTF8.self).contains("synthetic-watch-token"))
    }

    func testUploadBodyIsDurableAndReadableByTheSystemTransferService() throws {
        let file = try directory().appendingPathComponent("body")
        let body = Data("synthetic-upload".utf8)
        try Data("old".utf8).write(to: file, options: [.atomic, .completeFileProtection])
        try BackgroundUploader.writeUploadBody(body, to: file)
        XCTAssertEqual(try Data(contentsOf: file), body)
        #if !targetEnvironment(simulator)
        let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
        XCTAssertEqual(attributes[.protectionKey] as? FileProtectionType, .completeUntilFirstUserAuthentication)
        #endif
    }

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
