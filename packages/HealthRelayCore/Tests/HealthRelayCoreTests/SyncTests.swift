import XCTest
@testable import HealthRelayCore

@MainActor
final class SyncTests: XCTestCase {
    func task() -> AutomationConfig {
        var task = AutomationConfig.newTask()
        task.name = "Synthetic upload"
        task.data.selections = [MetricSelection(typeIdentifier: "HKQuantityTypeIdentifierBodyMass", unit: "kg")]
        task.destination.url = "https://receiver.example/ingest"
        return task
    }
    func journal() -> SyncJournal {
        SyncJournal(directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString))
    }
    func testFailedUploadSurvivesRestartWithIdenticalBatchAndCursor() async throws {
        let task = task(), journal = journal(), reader = FakeReader(), sender = FakeSender()
        sender.failure = ConfigurationError("offline")
        let engine = SyncEngine(reader: reader, sender: sender, journal: journal)
        _ = await engine.run(task)
        let before = try journal.load(task.id)
        XCTAssertNotNil(before.pending)
        XCTAssertTrue(before.checkpoints.isEmpty)
        let failedBody = sender.uploads[0].body
        sender.failure = nil
        let restarted = SyncEngine(reader: reader, sender: sender, journal: journal)
        _ = await restarted.run(task)
        XCTAssertEqual(sender.uploads[1].body, failedBody)
        XCTAssertEqual(sender.uploads[1].batchID, sender.uploads[0].batchID)
        XCTAssertEqual(reader.anchors, [nil, Data("next".utf8)])
        let after = try journal.load(task.id)
        XCTAssertNil(after.pending)
        XCTAssertEqual(after.checkpoints.values.first?.anchor, Data("next".utf8))
    }
    func testShortcutAutomaticRunRespectsRetryAfterAndManualOnlyPending() async throws {
        let task = task(), journal = journal(), reader = FakeReader(), sender = FakeSender()
        sender.failure = ConfigurationError("offline")
        let engine = SyncEngine(reader: reader, sender: sender, journal: journal)
        _ = await engine.run(task)
        var state = try journal.load(task.id)
        state.pending?.automaticRetry = true
        state.pending?.nextAttempt = Date().addingTimeInterval(3600)
        try journal.save(state, for: task.id)
        sender.failure = nil
        let waiting = await engine.run(task, automatic: true, trigger: "shortcut")
        XCTAssertEqual(waiting.state, .queued)
        XCTAssertEqual(sender.uploads.count, 1); XCTAssertEqual(reader.anchors.count, 1)
        state.pending?.nextAttempt = .distantPast; state.pending?.automaticRetry = false
        try journal.save(state, for: task.id)
        let manualOnly = await engine.run(task, automatic: true, trigger: "shortcut")
        XCTAssertEqual(manualOnly.state, .queued)
        XCTAssertEqual(sender.uploads.count, 1); XCTAssertEqual(reader.anchors.count, 1)
        XCTAssertEqual(try journal.load(task.id).pending?.body, state.pending?.body)
    }
    func testNoDataDoesNotSendAndRetainsBootstrapBoundary() async throws {
        let task = task(), journal = journal(), reader = FakeReader(), sender = FakeSender()
        reader.empty = true
        let engine = SyncEngine(reader: reader, sender: sender, journal: journal)
        _ = await engine.run(task)
        _ = await engine.run(task)
        XCTAssertTrue(sender.uploads.isEmpty)
        XCTAssertEqual(reader.starts[0], reader.starts[1])
    }
    func testInvalidReceiptNeverCommits() throws {
        let batch = UploadBatch(task: task(), records: [FakeReader.record])
        let wrong = Data("{\"batchId\":\"wrong\",\"committed\":true,\"accepted\":1,\"duplicates\":0}".utf8)
        XCTAssertThrowsError(try HTTPAcknowledgement.validate(status: 200, data: wrong, batchID: batch.batchId, count: 1, mode: .receipt))
        let valid = Data("{\"batchId\":\"\(batch.batchId)\",\"committed\":true,\"accepted\":1,\"duplicates\":0}".utf8)
        XCTAssertNoThrow(try HTTPAcknowledgement.validate(status: 201, data: valid, batchID: batch.batchId, count: 1, mode: .receipt))
        XCTAssertThrowsError(try HTTPAcknowledgement.validate(status: 202, data: Data(), batchID: batch.batchId, count: 1, mode: .http2xx))
        XCTAssertNoThrow(try HTTPAcknowledgement.validate(status: 204, data: Data(), batchID: batch.batchId, count: 1, mode: .http2xx))
    }
    func testPendingBatchBlocksConfigurationChangesAndDoesNotQuery() async throws {
        var task = task(); let journal = journal(), reader = FakeReader(), sender = FakeSender()
        sender.failure = ConfigurationError("offline")
        let engine = SyncEngine(reader: reader, sender: sender, journal: journal)
        _ = await engine.run(task)
        task.destination.url = "https://other.example/ingest"
        sender.failure = nil
        let outcome = await engine.run(task)
        XCTAssertEqual(outcome.state, .failed)
        XCTAssertEqual(reader.anchors.count, 1)
        XCTAssertEqual(sender.uploads.count, 1)
    }
    func testDeleteIsSerializedWithSampleIdentity() throws {
        let record = HealthRecord(op: .delete, typeIdentifier: "HKQuantityTypeIdentifierBodyMass", recordId: "uuid")
        let batch = UploadBatch(task: task(), records: [record])
        let object = try JSONSerialization.jsonObject(with: BatchEncoder.encode(batch).body) as! [String: Any]
        let records = object["records"] as! [[String: Any]]
        XCTAssertEqual(records[0]["op"] as? String, "delete")
        XCTAssertEqual(records[0]["recordId"] as? String, "uuid")
    }
}

@MainActor private final class FakeReader: HealthDataReader {
    static let record = HealthRecord(op: .upsert, typeIdentifier: "HKQuantityTypeIdentifierBodyMass", recordId: "synthetic-uuid", start: "2026-10-12T00:00:00Z", end: "2026-10-12T00:00:00Z", source: RecordSource(id: "test.synthetic", name: "Synthetic"), payload: ["value": .number(70), "unit": .string("kg")])
    var anchors: [Data?] = [], starts: [Date] = [], empty = false
    func read(task: AutomationConfig, selection: MetricSelection, checkpoint: TypeCheckpoint, limit: Int) async throws -> ReadPage {
        anchors.append(checkpoint.anchor); starts.append(checkpoint.start)
        return ReadPage(records: checkpoint.anchor == nil && !empty ? [Self.record] : [], anchor: Data("next".utf8), hasMore: false)
    }
}
@MainActor private final class FakeSender: UploadSender {
    var uploads: [PendingUpload] = []
    var failure: ConfigurationError?
    func send(_ upload: PendingUpload, destination: HTTPDestination) async throws -> Int {
        uploads.append(upload)
        if let failure { throw failure }
        return 204
    }
}

@MainActor final class SyncBoundaryTests: XCTestCase {
    func testDisplayNameDoesNotInvalidatePendingFingerprint() throws {
        var task = AutomationConfig.newTask()
        task.destination.url = "https://receiver.example/ingest"
        let first = try SyncIdentity.fingerprint(task)
        task.name = "Renamed"; task.revision += 1; task.enabled.toggle()
        XCTAssertEqual(first, try SyncIdentity.fingerprint(task))
        task.destination.url = "https://other.example/ingest"
        XCTAssertNotEqual(first, try SyncIdentity.fingerprint(task))
    }
    func testIncrementalKeyStaysFixedAcrossDaysWhileCalendarKeyChanges() throws {
        var task = AutomationConfig.newTask()
        let selection = MetricSelection(typeIdentifier: "HKQuantityTypeIdentifierBodyMass", unit: "kg")
        task.data.selections = [selection]
        let date = Date(timeIntervalSince1970: 1_792_000_000)
        XCTAssertEqual(try SyncIdentity.key(task, selection: selection, now: date).0,
                       try SyncIdentity.key(task, selection: selection, now: date.addingTimeInterval(86400)).0)
        task.range = DateRange(mode: .today)
        XCTAssertNotEqual(try SyncIdentity.key(task, selection: selection, now: date).0,
                          try SyncIdentity.key(task, selection: selection, now: date.addingTimeInterval(86400)).0)
    }
    func testNonRetryableAndRetryableHTTPStatuses() throws {
        for status in [401, 403, 409, 413, 422, 302] {
            do { try HTTPAcknowledgement.validate(status: status, data: Data(), batchID: "batch", count: 1, mode: .http2xx); XCTFail("Should fail") }
            catch let error as UploadFailure { XCTAssertFalse(error.retryable) }
        }
        for status in [408, 429, 500, 503] {
            do { try HTTPAcknowledgement.validate(status: status, data: Data(), batchID: "batch", count: 1, mode: .http2xx); XCTFail("Should fail") }
            catch let error as UploadFailure { XCTAssertTrue(error.retryable) }
        }
    }
    func testLegacyConfirmedLogMigratesLastConfirmedAt() throws {
        let journal = SyncJournal(directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString))
        let id = UUID()
        var state = SyncState()
        state.logs = [RunLog(state: .succeeded, message: "confirmed", records: 1)]
        try journal.save(state, for: id)
        let recovered = try journal.load(id)
        XCTAssertNotNil(recovered.lastConfirmedAt)
    }
    func testCorruptJournalIsNeverSilentlyReset() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let journal = SyncJournal(directory: root), id = UUID()
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let file = root.appendingPathComponent(id.uuidString + ".json")
        try Data("broken".utf8).write(to: file)
        XCTAssertThrowsError(try journal.load(id))
        XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), "broken")
    }
    func testTextFormatsKeepComplexPayloadAndDeletionOperation() throws {
        let task = AutomationConfig.newTask()
        let record = HealthRecord(op: .upsert, typeIdentifier: "test", recordId: "a\"b", payload: ["text": .string("a,b|c\nd")])
        let batch = UploadBatch(task: task, records: [record])
        let csv = String(decoding: try BatchEncoder.encode(batch, format: "csv").body, as: UTF8.self)
        XCTAssertTrue(csv.contains("\"a\"\"b\""))
        let markdown = String(decoding: try BatchEncoder.encode(batch, format: "markdown").body, as: UTF8.self)
        XCTAssertTrue(markdown.contains("&#124;"))
        XCTAssertThrowsError(try BatchEncoder.encode(batch, format: "hea.v1"))
    }
}

final class HEAFormatTests: XCTestCase {
    func testNativeTimestampAlwaysContainsOffsetAndRoundTrips() throws {
        let original = Date(timeIntervalSince1970: 1_791_792_000.123)
        let text = HealthTimestamp.string(original)
        XCTAssertTrue(text.hasSuffix("Z"))
        let parsed = try XCTUnwrap(AutomationConfig.parseDate(text))
        XCTAssertEqual(parsed.timeIntervalSince1970, original.timeIntervalSince1970, accuracy: 0.001)
    }
    func testRawHRVPublicShapeAndTimeZone() throws {
        let record = HealthRecord(op: .upsert, typeIdentifier: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN", recordId: "test-uuid", start: "2026-10-12T03:27:00.123Z", source: RecordSource(id: "test", name: "Synthetic Watch"), payload: ["value": .number(45), "unit": .string("ms")])
        let batch = UploadBatch(task: .newTask(), records: [record])
        let object = try JSONSerialization.jsonObject(with: BatchEncoder.encode(batch, format: "hea.v2", timeZone: "Asia/Shanghai").body) as! [String: Any]
        let metrics = (object["data"] as! [String: Any])["metrics"] as! [[String: Any]]
        XCTAssertEqual(metrics[0]["name"] as? String, "heart_rate_variability")
        let point = (metrics[0]["data"] as! [[String: Any]])[0]
        XCTAssertEqual(point["date"] as? String, "2026-10-12 11:27:00 +0800")
        XCTAssertEqual(point["qty"] as? Double, 45)
        XCTAssertNil(point["id"])
    }
    func testHEANeverSilentlyDropsDeletion() throws {
        let batch = UploadBatch(task: .newTask(), records: [HealthRecord(op: .delete, typeIdentifier: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN", recordId: "removed")])
        XCTAssertThrowsError(try BatchEncoder.encode(batch, format: "hea.v2"))
    }
}

private final class CancelledURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { client?.urlProtocol(self, didFailWithError: URLError(.cancelled)) }
    override func stopLoading() {}
}
@MainActor final class TransportCancellationTests: XCTestCase {
    func testCancelledURLSessionKeepsPendingRetryable() async throws {
        var task = AutomationConfig.newTask()
        task.data.selections = [MetricSelection(typeIdentifier: "HKQuantityTypeIdentifierBodyMass", unit: "kg")]
        task.destination.url = "https://receiver.example/ingest"
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CancelledURLProtocol.self]
        let sender = HTTPUploader(session: URLSession(configuration: configuration), credential: { _ in "unused" })
        let journal = SyncJournal(directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString))
        let engine = SyncEngine(reader: FakeReader(), sender: sender, journal: journal)
        let outcome = await engine.run(task)
        XCTAssertEqual(outcome.state, .failed)
        let state = try journal.load(task.id)
        XCTAssertTrue(try XCTUnwrap(state.pending).automaticRetry)
        XCTAssertTrue(state.checkpoints.isEmpty)
    }
}
