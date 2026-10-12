import XCTest
@testable import HealthRelayCore

/// Opt-in integration test. The credential file is local and ignored by Git.
/// This test refuses every host except the isolated acceptance Worker.
@MainActor final class CloudflareAcceptanceTests: XCTestCase {
    func testEngineAggregateCorrectionNoChangeAndMultipartOverHTTPS() async throws {
        guard let path = ProcessInfo.processInfo.environment["HEALTHRELAY_CLOUDFLARE_TEST_CONFIG"] else {
            throw XCTSkip("Set HEALTHRELAY_CLOUDFLARE_TEST_CONFIG to a private test-client file")
        }
        struct Client: Decodable { var endpoint: String; var key: String }
        let client = try JSONDecoder().decode(Client.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        let base = try XCTUnwrap(URL(string: client.endpoint))
        let endpoint = base.path.isEmpty || base.path == "/" ? base.appendingPathComponent("ingest") : base
        guard endpoint.scheme == "https", let host = endpoint.host, host.hasPrefix("healthrelay-acceptance."), host.hasSuffix(".workers.dev"), endpoint.path == "/ingest" else {
            XCTFail("Only the isolated acceptance Worker is permitted"); return
        }
        var task = AutomationConfig.newTask()
        task.name = "Synthetic integration"
        task.data.selections = [MetricSelection(typeIdentifier: "HKQuantityTypeIdentifierHeartRate", unit: "count/min")]
        task.export.mode = .aggregate; task.export.grouping = .hours; task.export.timeZone = "UTC"; task.export.format = "hea.v2"
        task.destination.url = endpoint.absoluteString + "/hea"; task.destination.acknowledgement = .receipt
        task.destination.headers = ["X-API-Key": client.key, "User-Agent": "HealthRelayAcceptance/1.0"]
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let source = AcceptanceSource(), sender = CountingHTTPSUploader()
        let engine = SyncEngine(reader: AggregationReader(source: source), sender: sender, journal: SyncJournal(directory: directory))
        let first = await engine.run(task)
        XCTAssertEqual(first.state, .succeeded, first.message); XCTAssertEqual(first.records, 1)
        let original = try XCTUnwrap(sender.uploads.first)
        // A lost-response retry sends the same bytes and receives the original receipt.
        let retryStatus = try await sender.send(original, destination: task.destination)
        XCTAssertEqual(retryStatus, 200)
        source.version = 2; source.average = 70
        let corrected = await engine.run(task)
        XCTAssertEqual(corrected.state, .succeeded, corrected.message)
        let requests = sender.uploads.count
        let unchanged = await engine.run(task)
        XCTAssertEqual(unchanged.state, .noData); XCTAssertEqual(sender.uploads.count, requests)
        let calls = source.snapshots
        _ = await engine.run(task)
        XCTAssertEqual(source.snapshots, calls)

        var inspect = URLComponents(url: endpoint, resolvingAgainstBaseURL: false)!
        inspect.path = "/inspect"; inspect.queryItems = [URLQueryItem(name: "taskId", value: task.id.uuidString.lowercased()), URLQueryItem(name: "type", value: "heart_rate")]
        var request = URLRequest(url: inspect.url!); request.setValue(client.key, forHTTPHeaderField: "X-API-Key")
        request.setValue("HealthRelayAcceptance/1.0", forHTTPHeaderField: "User-Agent")
        let (data, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let document = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let records = try XCTUnwrap(document["records"] as? [[String: Any]])
        XCTAssertEqual(records.count, 1)
        let payload = try XCTUnwrap(records.first?["payload"] as? [String: Any])
        XCTAssertEqual(payload["Avg"] as? Double, 70)

        // A new format is a separate query generation, with the same generic engine.
        task.export.format = "hea.csv"; task.destination.url = endpoint.absoluteString + "/hea-csv"
        let csv = await engine.run(task)
        XCTAssertEqual(csv.state, .succeeded, csv.message); XCTAssertEqual(csv.records, 1)
        XCTAssertTrue(sender.uploads.last?.contentType.hasPrefix("multipart/form-data;") == true)
    }
}

@MainActor private final class AcceptanceSource: AggregateSource {
    var version = 1, snapshots = 0
    var average = 60.0
    func readChanges(task: AutomationConfig, selection: MetricSelection, checkpoint: TypeCheckpoint, limit: Int) async throws -> ReadPage {
        let anchor = Data("v\(version)".utf8)
        let date = HealthTimestamp.string(Calendar(identifier: .gregorian).startOfDay(for: Date()).addingTimeInterval(3600))
        return ReadPage(records: checkpoint.anchor == anchor ? [] : [HealthRecord(op: .upsert, typeIdentifier: selection.id, recordId: "synthetic-\(version)", start: date, end: date)], anchor: anchor, hasMore: false)
    }
    func snapshot(task: AutomationConfig, selection: MetricSelection, window: AggregateWindow) async throws -> [String: JSONValue]? {
        snapshots += 1
        return ["aggregation": .bool(true), "unit": .string("count/min"), "value": .number(average), "average": .number(average), "minimum": .number(50), "maximum": .number(80)]
    }
}
@MainActor private final class CountingHTTPSUploader: UploadSender {
    var uploads: [PendingUpload] = []
    private let uploader = HTTPUploader(credential: { _ in "" })
    func send(_ upload: PendingUpload, destination: HTTPDestination) async throws -> Int {
        uploads.append(upload)
        return try await uploader.send(upload, destination: destination)
    }
}
