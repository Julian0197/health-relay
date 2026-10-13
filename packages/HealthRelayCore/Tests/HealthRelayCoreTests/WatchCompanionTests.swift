import XCTest
import CryptoKit
@testable import HealthRelayCore

@MainActor final class WatchCompanionTests: XCTestCase {
    func task() -> AutomationConfig {
        var task = AutomationConfig()
        task.data.selections = [MetricSelection(typeIdentifier: "HKQuantityTypeIdentifierBodyMass", unit: "kg")]
        task.destination.url = "https://receiver.example/ingest"
        return task
    }
    func testLegacyDeviceDefaultsToPhoneAndWatchRoundTrips() throws {
        let encoded = try JSONEncoder().encode(task())
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        object.removeValue(forKey: "device")
        XCTAssertEqual(try JSONDecoder().decode(AutomationConfig.self, from: JSONSerialization.data(withJSONObject: object)).device, .iPhone)
        var watch = task(); watch.device = .watch
        XCTAssertEqual(try JSONDecoder().decode(AutomationConfig.self, from: JSONEncoder().encode(watch)).device, .watch)
        XCTAssertNotEqual(try SyncIdentity.fingerprint(task()), try SyncIdentity.fingerprint(watch))
    }
    func testPhoneFingerprintKeepsLegacyPersistedBatchIdentity() throws {
        struct LegacyQuery: Encodable { var data: DataSelection; var range: DateRange; var export: ExportSettings }
        struct LegacyRequest: Encodable { var query: LegacyQuery; var destination: HTTPDestination }
        let task = task()
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        let bytes = try encoder.encode(LegacyRequest(query: LegacyQuery(data: task.data, range: task.range, export: task.export), destination: task.destination))
        let legacy = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(try SyncIdentity.fingerprint(task), legacy)
    }
    func testOwnershipWaitsForMatchingRemovalReceipt() throws {
        let task = task()
        var ledger = WatchOwnershipLedger()
        let first = UUID(), second = UUID()
        ledger.queued(id: first, taskIDs: [task.id])
        XCTAssertTrue(ledger.possibleWatchIDs.contains(task.id))
        ledger.queued(id: second, taskIDs: [])
        XCTAssertFalse(ledger.received(id: first, accepted: true))
        XCTAssertTrue(ledger.possibleWatchIDs.contains(task.id))
        XCTAssertTrue(ledger.received(id: second, accepted: false))
        XCTAssertTrue(ledger.possibleWatchIDs.contains(task.id))
        let recovered = try JSONDecoder().decode(WatchOwnershipLedger.self, from: JSONEncoder().encode(ledger))
        XCTAssertEqual(recovered.possibleWatchIDs, ledger.possibleWatchIDs)
        XCTAssertTrue(ledger.received(id: second, accepted: true))
        XCTAssertTrue(ledger.possibleWatchIDs.isEmpty)
    }
    func testOfflineResponseIsRetryableAndIdentityIgnoresJSONKeyOrder() throws {
        let url = URL(string: "https://receiver.example/ingest")!
        XCTAssertFalse(BackgroundUploadPolicy.redirected(original: url, current: url, response: nil))
        XCTAssertFalse(BackgroundUploadPolicy.redirected(original: url, current: nil, response: nil))
        XCTAssertTrue(BackgroundUploadPolicy.redirected(original: url, current: URL(string: "https://other.example"), response: nil))
        XCTAssertTrue(BackgroundUploadPolicy.redirected(original: url, current: url, response: URL(string: "https://other.example")))
        let identity = BatchIdentity(taskID: UUID(), batchID: "batch", fingerprint: "fingerprint")
        let wire = "{\"fingerprint\":\"fingerprint\",\"batchID\":\"batch\",\"taskID\":\"\(identity.taskID.uuidString)\"}"
        XCTAssertEqual(BatchIdentity.decodeDescription(wire), identity)
    }
    func testWatchReceiptAndTasksPersistInOneAtomicEnvelope() throws {
        let repository = ConfigurationRepository(fileURL: .temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathComponent("tasks.json"))
        var task = task(); task.device = .watch
        let receipt = WatchSnapshotReceipt(id: UUID(), generation: 10, accepted: true)
        try repository.save([task], watchReceipt: receipt)
        XCTAssertEqual(try repository.load().map(\.id), [task.id])
        XCTAssertEqual(try repository.loadWatchReceipt(), receipt)
        XCTAssertThrowsError(try repository.save([task, task], watchReceipt: WatchSnapshotReceipt(id: UUID(), generation: 11, accepted: true)))
        XCTAssertEqual(try repository.loadWatchReceipt(), receipt)
    }
    func testWatchAvailabilityUsesWatchVersion() {
        var watch = task(); watch.device = .watch
        XCTAssertTrue(watch.validationIssues(systemMajorVersion: 11, device: .watch).isEmpty)
        watch.data.selections = [MetricSelection(typeIdentifier: "HKQuantityTypeIdentifierHeartRateVariabilityRMSSD", unit: "ms")]
        XCTAssertTrue(watch.validationIssues(systemMajorVersion: 11, device: .watch).contains { $0.contains("watchOS 27") })
    }
    func testPreparePersistsWithoutSendingOrCommittingAndRelaunchKeepsBatch() async throws {
        let journal = SyncJournal(directory: .temporaryDirectory.appendingPathComponent(UUID().uuidString))
        let reader = WatchTestReader(), sender = WatchTestSender(), task = task()
        let log = await SyncEngine(reader: reader, sender: sender, journal: journal).run(task, prepareOnly: true)
        XCTAssertEqual(log.state, .queued)
        let before = try journal.load(task.id)
        XCTAssertNotNil(before.pending); XCTAssertTrue(before.checkpoints.isEmpty); XCTAssertEqual(sender.sends, 0)
        _ = await SyncEngine(reader: reader, sender: sender, journal: journal).run(task, prepareOnly: true)
        XCTAssertEqual(try journal.load(task.id).pending?.batchID, before.pending?.batchID)
        XCTAssertEqual(reader.reads, 1)
        let pending = try XCTUnwrap(before.pending)
        let identity = BatchIdentity(taskID: task.id, batchID: pending.batchID, fingerprint: pending.configurationFingerprint)
        var wrong = identity; wrong.batchID = "stale"
        XCTAssertFalse(try journal.confirm(wrong, task: task, status: 204, data: Data()))
        wrong = identity; wrong.taskID = UUID()
        XCTAssertFalse(try journal.confirm(wrong, task: task, status: 204, data: Data()))
        wrong = identity; wrong.fingerprint = "stale"
        XCTAssertFalse(try journal.confirm(wrong, task: task, status: 204, data: Data()))
        XCTAssertTrue(try journal.load(task.id).checkpoints.isEmpty)
        XCTAssertTrue(try journal.confirm(identity, task: task, status: 204, data: Data()))
        XCTAssertFalse(try journal.confirm(identity, task: task, status: 204, data: Data()))
        XCTAssertEqual(try journal.load(task.id).checkpoints.values.first?.anchor, Data("next".utf8))
    }
    func testWrongReceiptAndHTTPFailureKeepExactPendingAndBackoff() async throws {
        var task = task(); task.destination.acknowledgement = .receipt
        let journal = SyncJournal(directory: .temporaryDirectory.appendingPathComponent(UUID().uuidString))
        _ = await SyncEngine(reader: WatchTestReader(), sender: WatchTestSender(), journal: journal).run(task, prepareOnly: true)
        let pending = try XCTUnwrap(journal.load(task.id).pending)
        let identity = BatchIdentity(taskID: task.id, batchID: pending.batchID, fingerprint: pending.configurationFingerprint)
        XCTAssertThrowsError(try journal.confirm(identity, task: task, status: 200, data: Data("{}".utf8)))
        for status in [400, 500] { XCTAssertThrowsError(try journal.confirm(identity, task: task, status: status, data: Data())) }
        XCTAssertTrue(try journal.recordFailure(identity, failure: UploadFailure("offline", retryable: true, retryAfter: 120)))
        let restarted = SyncJournal(directory: journal.directory)
        XCTAssertEqual(try restarted.load(task.id).pending?.batchID, pending.batchID)
        XCTAssertEqual(try restarted.load(task.id).pending?.attempts, 1)
        XCTAssertNotNil(try restarted.load(task.id).pending?.nextAttempt)
        XCTAssertTrue(try restarted.load(task.id).checkpoints.isEmpty)
        let receipt = Data("{\"batchId\":\"\(pending.batchID)\",\"committed\":true,\"accepted\":1,\"duplicates\":0}".utf8)
        XCTAssertTrue(try restarted.confirm(identity, task: task, status: 200, data: receipt))
    }
    func testSnapshotIsDisabledAndNeverCarriesPhoneSecretsOrReferences() throws {
        var watch = task(); watch.device = .watch; watch.enabled = true
        watch.destination.credentialRef = "phone-reference"; watch.destination.credentialHeader = "Authorization"
        watch.destination.secretHeaders = ["X-Key": "phone-header-reference"]
        watch.destination.headers["X-Token"] = "raw-phone-secret"
        let snapshot = try WatchConfigurationSnapshot(tasks: [watch])
        let wire = String(decoding: try JSONEncoder().encode(snapshot), as: UTF8.self)
        XCTAssertFalse(snapshot.tasks[0].enabled)
        for forbidden in ["phone-reference", "phone-header-reference", "raw-phone-secret"] { XCTAssertFalse(wire.contains(forbidden)) }
        XCTAssertEqual(Set(snapshot.tasks[0].destination.requiredSecretHeaders ?? []), ["X-Key", "X-Token"])
        XCTAssertNil(snapshot.tasks[0].destination.credentialRef)
        XCTAssertThrowsError(try WatchConfigurationSnapshot(tasks: [task()]))
        var invalid = snapshot; invalid.tasks[0].destination.headers["Authorization"] = "raw-secret"
        XCTAssertThrowsError(try invalid.validate())
        invalid = snapshot; invalid.tasks[0].destination.credentialRef = "untrusted-local-reference"
        XCTAssertThrowsError(try invalid.validate())
    }
    func testExplicitDiscardOnlyClearsMatchingBatchWithoutAdvancingCheckpoint() async throws {
        let task = task(), journal = SyncJournal(directory: .temporaryDirectory.appendingPathComponent(UUID().uuidString))
        _ = await SyncEngine(reader: WatchTestReader(), sender: WatchTestSender(), journal: journal).run(task, prepareOnly: true)
        let pending = try XCTUnwrap(journal.load(task.id).pending)
        let identity = BatchIdentity(taskID: task.id, batchID: pending.batchID, fingerprint: pending.configurationFingerprint)
        var wrong = identity; wrong.batchID = "different"
        XCTAssertFalse(try journal.discard(wrong))
        XCTAssertNotNil(try journal.load(task.id).pending)
        XCTAssertTrue(try journal.discard(identity))
        XCTAssertNil(try journal.load(task.id).pending)
        XCTAssertTrue(try journal.load(task.id).checkpoints.isEmpty)
        XCTAssertFalse(try journal.confirm(identity, task: task, status: 204, data: Data()))
    }
    func testSnapshotRejectsUnsupportedExecutionButAllowsUnboundLocalCredentials() throws {
        var watch = task(); watch.device = .watch
        watch.destination.credentialHeader = "Authorization"
        XCTAssertNoThrow(try WatchConfigurationSnapshot(tasks: [watch]))
        watch.export.format = "hea.v1"
        XCTAssertNoThrow(try WatchConfigurationSnapshot(tasks: [watch]))
        watch.export.format = "hea.v2"
        watch.data.family = .workout; watch.data.selections = [MetricSelection(typeIdentifier: "HKWorkoutType")]
        XCTAssertNoThrow(try WatchConfigurationSnapshot(tasks: [watch]))
        watch.export.heaDataType = .medications
        XCTAssertThrowsError(try WatchConfigurationSnapshot(tasks: [watch]))
        watch.export.heaDataType = nil
        watch.export.format = "healthrelay.v1"
        var options = WorkoutOptions(); options.includeRoutes = true
        watch.data.workoutOptions = options
        XCTAssertNoThrow(try WatchConfigurationSnapshot(tasks: [watch]))
    }
    func testLegacyImplicitAuthorizationSurvivesSanitizationAndRepeatedBinding() throws {
        var watch = task(); watch.device = .watch
        watch.destination.credentialRef = "phone-legacy-reference"
        watch.destination.credentialPrefix = "Bearer "
        let snapshot = try WatchConfigurationSnapshot(tasks: [watch])
        let portable = try XCTUnwrap(snapshot.tasks.first)
        XCTAssertEqual(portable.destination.credentialHeader, "Authorization")
        XCTAssertEqual(portable.destination.credentialPrefix, "Bearer ")
        XCTAssertNil(portable.destination.credentialRef)
        XCTAssertFalse(portable.executionIssues.isEmpty)
        XCTAssertFalse(String(decoding: try JSONEncoder().encode(snapshot), as: UTF8.self).contains("phone-legacy-reference"))
        var local = watch; local.destination.credentialRef = "watch-local-reference"
        let bound = try XCTUnwrap(snapshot.localTasks(current: [local]).first)
        XCTAssertEqual(bound.destination.credentialRef, "watch-local-reference")
        XCTAssertTrue(bound.executionIssues.isEmpty)
        let again = try WatchConfigurationSnapshot(tasks: [watch]).localTasks(current: [bound])
        XCTAssertEqual(again.first?.destination.credentialRef, "watch-local-reference")
    }
    func testSnapshotRejectsPendingRemovalOrChange() async throws {
        var watch = task(); watch.device = .watch
        let journal = SyncJournal(directory: .temporaryDirectory.appendingPathComponent(UUID().uuidString))
        _ = await SyncEngine(reader: WatchTestReader(), sender: WatchTestSender(), journal: journal).run(watch, prepareOnly: true)
        XCTAssertThrowsError(try WatchConfigurationSnapshot.validateReplacement(current: [watch], incoming: [], journal: journal))
        var changed = watch; changed.destination.url = "https://other.example/upload"
        XCTAssertThrowsError(try WatchConfigurationSnapshot.validateReplacement(current: [watch], incoming: [changed], journal: journal))
        XCTAssertNoThrow(try WatchConfigurationSnapshot.validateReplacement(current: [watch], incoming: [watch], journal: journal))
    }
}

@MainActor private final class WatchTestReader: HealthDataReader {
    var reads = 0
    func read(task: AutomationConfig, selection: MetricSelection, checkpoint: TypeCheckpoint, limit: Int) async throws -> ReadPage {
        reads += 1
        return ReadPage(records: checkpoint.anchor == nil ? [HealthRecord(op: .upsert, typeIdentifier: selection.id, recordId: "synthetic", payload: ["value": .number(70)])] : [], anchor: Data("next".utf8), hasMore: false)
    }
}
@MainActor private final class WatchTestSender: UploadSender {
    var sends = 0
    func send(_ upload: PendingUpload, destination: HTTPDestination) async throws -> Int { sends += 1; return 204 }
}
