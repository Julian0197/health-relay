import XCTest
@testable import HealthRelayCore

/// Exercises the deferred journal protocol over a real isolated HTTPS receiver.
/// This is not a watchOS background scheduler or physical HealthKit test.
@MainActor final class WatchDeferredCloudflareTests: XCTestCase {
    func testPreparedWatchBatchSurvivesLostAcknowledgementOverHTTPS() async throws {
        guard let path = ProcessInfo.processInfo.environment["HEALTHRELAY_CLOUDFLARE_TEST_CONFIG"] else {
            throw XCTSkip("Opt-in isolated Cloudflare receiver test")
        }
        struct Client: Decodable { let endpoint: String; let key: String }
        let client = try JSONDecoder().decode(Client.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        let base = try XCTUnwrap(URL(string: client.endpoint))
        let endpoint = base.path.isEmpty || base.path == "/" ? base.appendingPathComponent("ingest") : base
        guard endpoint.scheme == "https", let host = endpoint.host,
              host.hasPrefix("healthrelay-acceptance."), host.hasSuffix(".workers.dev"), endpoint.path == "/ingest" else {
            XCTFail("This test only permits the isolated acceptance Worker"); return
        }
        var task = AutomationConfig()
        task.device = .watch
        task.name = "Synthetic Watch deferred delivery"
        task.data.selections = [MetricSelection(typeIdentifier: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN", unit: "ms")]
        task.destination.url = endpoint.absoluteString
        task.destination.acknowledgement = .receipt
        task.destination.headers = ["X-API-Key": client.key]
        let directory = URL.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let journal = SyncJournal(directory: directory)
        let neverSend = DeferredNetworkTestSender()
        let reader = DeferredNetworkTestReader()
        let prepared = await SyncEngine(reader: reader, sender: neverSend, journal: journal).run(task, prepareOnly: true)
        XCTAssertEqual(prepared.state, .queued, prepared.message)
        let pending = try XCTUnwrap(journal.load(task.id).pending)
        XCTAssertTrue(try journal.load(task.id).checkpoints.isEmpty)
        XCTAssertEqual(neverSend.calls, 0)
        let identity = BatchIdentity(taskID: task.id, batchID: pending.batchID, fingerprint: pending.configurationFingerprint)

        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue(pending.contentType, forHTTPHeaderField: "Content-Type")
        request.setValue(pending.batchID, forHTTPHeaderField: "Idempotency-Key")
        request.setValue(client.key, forHTTPHeaderField: "X-API-Key")
        request.setValue("HealthRelayWatchAcceptance/1.0", forHTTPHeaderField: "User-Agent")
        let session = URLSession(configuration: .ephemeral, delegate: NoRedirectDelegate(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        // Simulate a committed request whose acknowledgement wasn't persisted before exit.
        let (firstBody, firstResponse) = try await session.upload(for: request, from: pending.body)
        let firstStatus = try XCTUnwrap((firstResponse as? HTTPURLResponse)?.statusCode)
        XCTAssertEqual(firstStatus, 200, String(data: firstBody, encoding: .utf8) ?? "Invalid response body")
        try HTTPAcknowledgement.validate(status: firstStatus, data: firstBody, batchID: pending.batchID, count: pending.recordCount, mode: .receipt)
        let restored = SyncJournal(directory: directory)
        XCTAssertEqual(try restored.load(task.id).pending?.body, pending.body)
        XCTAssertTrue(try restored.load(task.id).checkpoints.isEmpty)

        // Retry precisely the same batch. Server must respond with a valid idempotent receipt.
        let (body, response) = try await session.upload(for: request, from: pending.body)
        let status = try XCTUnwrap((response as? HTTPURLResponse)?.statusCode)
        XCTAssertTrue(try restored.confirm(identity, task: task, status: status, data: body))
        XCTAssertFalse(try restored.confirm(identity, task: task, status: status, data: body))
        XCTAssertNil(try restored.load(task.id).pending)
        XCTAssertEqual(try restored.load(task.id).checkpoints.values.first?.anchor, Data("synthetic-watch-1".utf8))
        let next = await SyncEngine(reader: reader, sender: neverSend, journal: restored).run(task, prepareOnly: true)
        XCTAssertEqual(next.state, .noData, next.message)
        XCTAssertEqual(neverSend.calls, 0)

        let wireBatch = try XCTUnwrap(JSONSerialization.jsonObject(with: pending.body) as? [String: Any])
        let wireTaskID = try XCTUnwrap(wireBatch["taskId"] as? String)
        var inspect = try XCTUnwrap(URLComponents(url: endpoint, resolvingAgainstBaseURL: false))
        inspect.path = "/inspect"
        inspect.queryItems = [URLQueryItem(name: "taskId", value: wireTaskID), URLQueryItem(name: "type", value: task.data.selections[0].id)]
        var inspectRequest = URLRequest(url: try XCTUnwrap(inspect.url))
        inspectRequest.setValue(client.key, forHTTPHeaderField: "X-API-Key")
        inspectRequest.setValue("HealthRelayWatchAcceptance/1.0", forHTTPHeaderField: "User-Agent")
        let (inspection, inspectionResponse) = try await session.data(for: inspectRequest)
        XCTAssertEqual((inspectionResponse as? HTTPURLResponse)?.statusCode, 200)
        let document = try XCTUnwrap(JSONSerialization.jsonObject(with: inspection) as? [String: Any])
        let records = try XCTUnwrap(document["records"] as? [[String: Any]])
        XCTAssertEqual(records.count, 1, "Retry must not create a second stored record")
    }
}

@MainActor private final class DeferredNetworkTestReader: HealthDataReader {
    func read(task: AutomationConfig, selection: MetricSelection, checkpoint: TypeCheckpoint, limit: Int) async throws -> ReadPage {
        let timestamp = HealthTimestamp.string(Date(timeIntervalSince1970: 1_790_000_000))
        let records = checkpoint.anchor == nil ? [HealthRecord(op: .upsert, typeIdentifier: selection.id, recordId: "synthetic-watch-deferred", start: timestamp, end: timestamp, source: RecordSource(id: "org.healthrelay.synthetic-watch", name: "Synthetic Watch"), payload: ["value": .number(42), "unit": .string("ms")])] : []
        return ReadPage(records: records, anchor: Data("synthetic-watch-1".utf8), hasMore: false)
    }
}
@MainActor private final class DeferredNetworkTestSender: UploadSender {
    var calls = 0
    func send(_ upload: PendingUpload, destination: HTTPDestination) async throws -> Int {
        calls += 1
        throw ConfigurationError("prepareOnly must not call the synchronous sender")
    }
}
