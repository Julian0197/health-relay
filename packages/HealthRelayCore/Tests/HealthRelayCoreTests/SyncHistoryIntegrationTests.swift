import XCTest
@testable import HealthRelayCore

@MainActor final class SyncHistoryIntegrationTests: XCTestCase {
    private func fixture() throws -> (URL, SyncHistoryStore, SyncJournal, AutomationConfig) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let history = SyncHistoryStore(file: root.appendingPathComponent("history/history.sqlite"))
        let journal = SyncJournal(directory: root.appendingPathComponent("sync"), history: history)
        var task = AutomationConfig.newTask()
        task.name = "历史测试"; task.destination.url = "https://receiver.example/ingest?private=never-save"
        task.data.selections = [MetricSelection(typeIdentifier: "HKQuantityTypeIdentifierHeartRate", unit: "count/min")]
        return (root, history, journal, task)
    }
    func testPartialSuccessAndRetryKeepTwoBatchesAndTheirOwnSummaries() async throws {
        let (_, history, journal, task) = try fixture(), sender = HistorySender(), reader = HistoryReader()
        sender.failCall = 2
        let engine = SyncEngine(reader: reader, sender: sender, journal: journal)
        let first = await engine.run(task); XCTAssertEqual(first.state, .failed)
        var rows = try history.page().entries
        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(rows.filter { $0.state == .succeeded }.count, 1)
        XCTAssertEqual(rows.filter { $0.state == .failed }.count, 1)
        let pending = try XCTUnwrap(journal.load(task.id).pending)
        XCTAssertEqual(pending.history?.summary.metrics.first?.latestValue, 82)
        XCTAssertEqual(try journal.load(task.id).checkpoints.count, 1)
        let retried = await engine.run(task); XCTAssertEqual(retried.state, .succeeded)
        rows = try history.page().entries
        XCTAssertEqual(rows.count, 2)
        XCTAssertTrue(rows.allSatisfy { $0.state == .succeeded })
        XCTAssertEqual(rows.first { $0.batchID == pending.batchID }?.attempts, 2)
        XCTAssertFalse(String(decoding: try JSONEncoder().encode(rows), as: UTF8.self).contains("never-save"))
    }
    func testDeferredReceiptKeepsActualCallbackTimeAcrossRestartAndDuplicateDelivery() async throws {
        let (root, history, journal, original) = try fixture()
        var task = original; task.device = .watch; task.enabled = true
        let queuedAt = Date().addingTimeInterval(-60)
        let engine = SyncEngine(reader: HistoryReader(), sender: HistorySender(), journal: journal, now: { queuedAt })
        let prepared = await engine.run(task, prepareOnly: true); XCTAssertEqual(prepared.state, .queued)
        let pending = try XCTUnwrap(journal.load(task.id).pending)
        let identity = BatchIdentity(taskID: task.id, batchID: pending.batchID, fingerprint: pending.configurationFingerprint)
        let callbackAt = Date().addingTimeInterval(-30)
        try journal.markSending(identity, attemptID: "watch-attempt", at: callbackAt.addingTimeInterval(-1))
        let restored = SyncJournal(directory: root.appendingPathComponent("sync"), history: history)
        XCTAssertTrue(try restored.confirm(identity, task: task, status: 204, data: Data(), now: callbackAt, completionID: "watch-done", attemptID: "watch-attempt"))
        XCTAssertFalse(try restored.confirm(identity, task: task, status: 204, data: Data(), now: Date(), completionID: "watch-done", attemptID: "watch-attempt"))
        XCTAssertEqual(try history.page().entries[0].confirmedAt!.timeIntervalSince1970, callbackAt.timeIntervalSince1970, accuracy: 0.001)
        XCTAssertEqual(try history.page().entries[0].attempts, 1)
        XCTAssertNil(try restored.load(task.id).pending)
    }
    func testHistoryProjectionFailureCannotUndoCommittedUploadAndRecoversFromJournal() async throws {
        let (root, _, _, task) = try fixture()
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let blocked = root.appendingPathComponent("blocked")
        try Data("not a directory".utf8).write(to: blocked)
        let history = SyncHistoryStore(file: blocked.appendingPathComponent("history.sqlite"))
        let journal = SyncJournal(directory: root.appendingPathComponent("sync"), history: history)
        let sender = HistorySender()
        let outcome = await SyncEngine(reader: HistoryReader(), sender: sender, journal: journal).run(task)
        XCTAssertEqual(outcome.state, .succeeded)
        XCTAssertNil(try journal.load(task.id).pending)
        XCTAssertNotNil(journal.historyError)
        XCTAssertFalse(try journal.load(task.id).historyEvents?.isEmpty ?? true)
        try FileManager.default.removeItem(at: blocked)
        journal.recoverHistory()
        XCTAssertNil(journal.historyError)
        XCTAssertEqual(try history.page().entries.count, 2)
        XCTAssertTrue(try journal.load(task.id).historyEvents?.isEmpty ?? true)
        XCTAssertEqual(sender.calls, 2)
    }
    func testLegacyMigrationIsIdempotentAndOmitsNoDataAndExpiredLogs() throws {
        let (_, history, journal, task) = try fixture(), now = Date()
        var state = SyncState()
        var old = RunLog(state: .failed, message: "旧错误"); old.date = now.addingTimeInterval(-21 * 86400)
        let success = RunLog(state: .succeeded, message: "旧版确认", records: 5, batches: 2)
        state.logs = [success, RunLog(state: .noData, message: "没有新数据"), old]
        try journal.save(state, for: task.id)
        try journal.migrateHistory(task: task)
        try journal.migrateHistory(task: task)
        let rows = try history.page().entries
        XCTAssertEqual(rows.count, 1)
        XCTAssertTrue(rows[0].legacy)
        XCTAssertEqual(rows[0].summary.recordCount, 5)
        XCTAssertTrue(rows[0].summary.metrics.isEmpty)
        XCTAssertEqual(try XCTUnwrap(rows[0].confirmedAt).timeIntervalSince1970, success.date.timeIntervalSince1970, accuracy: 0.001)
    }
    func testDiscardRecordsCancellationWithoutAdvancingCheckpoint() async throws {
        let (_, history, journal, original) = try fixture()
        var task = original; task.device = .watch; task.enabled = true
        _ = await SyncEngine(reader: HistoryReader(), sender: HistorySender(), journal: journal).run(task, prepareOnly: true)
        let pending = try XCTUnwrap(journal.load(task.id).pending)
        let identity = BatchIdentity(taskID: task.id, batchID: pending.batchID, fingerprint: pending.configurationFingerprint)
        XCTAssertTrue(try journal.discard(identity))
        XCTAssertEqual(try history.page().entries[0].state, .cancelled)
        XCTAssertTrue(try journal.load(task.id).checkpoints.isEmpty)
    }
    func testLegacyCallbackWithoutRecordedCompletionTimeDoesNotInventSyncTime() async throws {
        let (_, history, journal, task) = try fixture()
        _ = await SyncEngine(reader: HistoryReader(), sender: HistorySender(), journal: journal).run(task, prepareOnly: true)
        let pending = try XCTUnwrap(journal.load(task.id).pending)
        let identity = BatchIdentity(taskID: task.id, batchID: pending.batchID, fingerprint: pending.configurationFingerprint)
        XCTAssertTrue(try journal.confirm(identity, task: task, status: 204, data: Data(), confirmationTimeKnown: false))
        let row = try XCTUnwrap(history.page().entries.first)
        XCTAssertEqual(row.state, .succeeded)
        XCTAssertNil(row.confirmedAt)
    }
    func testDuplicateFailureAndStaleAttemptCannotInflateRetriesOrOverrideSuccess() async throws {
        let (_, history, journal, task) = try fixture()
        _ = await SyncEngine(reader: HistoryReader(), sender: HistorySender(), journal: journal).run(task, prepareOnly: true)
        let pending = try XCTUnwrap(journal.load(task.id).pending)
        let identity = BatchIdentity(taskID: task.id, batchID: pending.batchID, fingerprint: pending.configurationFingerprint)
        try journal.markSending(identity, attemptID: "first")
        let failure = UploadFailure("离线", retryable: true)
        XCTAssertTrue(try journal.recordFailure(identity, failure: failure, completionID: "failure", attemptID: "first"))
        XCTAssertFalse(try journal.recordFailure(identity, failure: failure, completionID: "failure", attemptID: "first"))
        XCTAssertEqual(try journal.load(task.id).pending?.attempts, 1)
        try journal.markSending(identity, attemptID: "second")
        XCTAssertFalse(try journal.recordFailure(identity, failure: failure, completionID: "late", attemptID: "first"))
        XCTAssertTrue(try journal.confirm(identity, task: task, status: 204, data: Data(), completionID: "success", attemptID: "second"))
        XCTAssertFalse(try journal.recordFailure(identity, failure: failure, completionID: "later", attemptID: "second"))
        let row = try XCTUnwrap(history.page().entries.first)
        XCTAssertEqual(row.state, .succeeded); XCTAssertEqual(row.attempts, 2)
    }
    func testReadFailureHasNoBatchAndEmptyAutomaticChecksDoNotCreateHistory() async throws {
        let (_, history, journal, original) = try fixture()
        var task = original; task.enabled = true
        let reader = EmptyHistoryReader()
        let engine = SyncEngine(reader: reader, sender: HistorySender(), journal: journal)
        let empty = await engine.run(task, automatic: true)
        XCTAssertEqual(empty.state, .noData); XCTAssertTrue(try history.page().entries.isEmpty)
        reader.fail = true
        let failed = await engine.run(task)
        XCTAssertEqual(failed.state, .failed)
        let row = try XCTUnwrap(history.page().entries.first)
        XCTAssertNil(row.batchID); XCTAssertEqual(row.state, .failed)
        XCTAssertEqual(row.summary.recordCount, 0)
    }
    func testWorkoutHistoryIsAttributedToOriginalTaskAndUsesLatestCumulativeSummary() throws {
        let (root, history, _, task) = try fixture(), now = Date(), originalID = UUID()
        var binding = task; binding.device = .watch; binding.enabled = true
        binding.data.family = .workout; binding.data.selections = [MetricSelection(typeIdentifier: "HKWorkoutType")]
        binding.destination.acknowledgement = .receipt
        let relay = WorkoutRelayOutbox(directory: root.appendingPathComponent("workout"), history: history)
        try relay.begin(task: binding, historyTaskID: originalID)
        let record = try WorkoutLiveSample(sessionID: binding.id, start: now.addingTimeInterval(-60), observedAt: now,
            elapsedSeconds: 50, activityType: 37, state: .running).record()
        try relay.offer([record], terminal: false)
        let pending = try XCTUnwrap(relay.prepare(now: now))
        let row = try XCTUnwrap(history.page(taskID: originalID).entries.first)
        XCTAssertEqual(row.context.kind, .workout)
        XCTAssertEqual(row.summary.metrics[0].latestValue, 50)
        XCTAssertEqual(row.batchID, pending.batchID)
    }
}
@MainActor private final class EmptyHistoryReader: HealthDataReader {
    var fail = false
    func read(task: AutomationConfig, selection: MetricSelection, checkpoint: TypeCheckpoint, limit: Int) async throws -> ReadPage {
        if fail { throw ConfigurationError("健康数据暂不可读") }
        return ReadPage(records: [], anchor: nil, hasMore: false)
    }
}

@MainActor private final class HistoryReader: HealthDataReader {
    func read(task: AutomationConfig, selection: MetricSelection, checkpoint: TypeCheckpoint, limit: Int) async throws -> ReadPage {
        let index = checkpoint.anchor.flatMap { String(data: $0, encoding: .utf8) }.flatMap(Int.init) ?? 0
        guard index < 2 else { return ReadPage(records: [], anchor: checkpoint.anchor, hasMore: false) }
        let record = HealthRecord(op: .upsert, typeIdentifier: selection.id, recordId: "r\(index)", start: Date().ISO8601Format(),
            payload: ["value": .number(index == 0 ? 72 : 82), "unit": .string("count/min")])
        return ReadPage(records: [record], anchor: Data("\(index + 1)".utf8), hasMore: index == 0)
    }
}
@MainActor private final class HistorySender: UploadSender {
    var calls = 0, failCall: Int?
    func send(_ upload: PendingUpload, destination: HTTPDestination) async throws -> Int {
        calls += 1
        if calls == failCall { throw UploadFailure("暂时离线", retryable: true) }
        return 204
    }
}
