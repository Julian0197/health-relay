import XCTest
import CryptoKit
@testable import HealthRelayCore

@MainActor final class HeartSeriesMigrationTests: XCTestCase {
    private let heart = MetricSelection(typeIdentifier: "HKQuantityTypeIdentifierHeartRate", unit: "count/min")
    private let steps = MetricSelection(typeIdentifier: "HKQuantityTypeIdentifierStepCount", unit: "count")
    private let date = Date(timeIntervalSince1970: 1_792_720_800)

    private func task(device: ExecutionDevice = .iPhone) -> AutomationConfig {
        var task = AutomationConfig.newTask()
        task.device = device; task.enabled = true
        task.data.family = .healthMetrics; task.data.selections = [heart, steps]
        task.range = DateRange(mode: .incremental, bootstrapDays: 30)
        task.export.timeZone = "Asia/Shanghai"
        task.destination.url = "https://receiver.example/ingest"
        return task
    }

    private struct LegacyQuery: Encodable {
        var data: DataSelection; var range: DateRange; var export: ExportSettings
    }
    private struct LegacyRequest: Encodable {
        var query: LegacyQuery; var destination: HTTPDestination; var device: ExecutionDevice?
    }
    private func digest<T: Encodable>(_ value: T) throws -> String {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        return SHA256.hash(data: try encoder.encode(value)).map { String(format: "%02x", $0) }.joined()
    }
    private func legacyKey(_ task: AutomationConfig, _ selection: MetricSelection) throws -> String {
        try digest(LegacyQuery(data: task.data, range: task.range, export: task.export)) + ":" + selection.id + ":incremental"
    }
    private func legacyFingerprint(_ task: AutomationConfig) throws -> String {
        try digest(LegacyRequest(query: LegacyQuery(data: task.data, range: task.range, export: task.export),
                                 destination: task.destination, device: task.device == .watch ? .watch : nil))
    }
    private func journal() -> SyncJournal {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return SyncJournal(directory: directory)
    }
    private func legacyState(_ task: AutomationConfig) throws -> SyncState {
        var state = SyncState()
        state.cycleStartedAt = date.addingTimeInterval(-3600)
        state.cycleFingerprint = try legacyFingerprint(task)
        state.nextSelectionID = steps.id // The old cycle already passed HeartRate.
        for selection in task.data.selections {
            state.checkpoints[try legacyKey(task, selection)] = TypeCheckpoint(start: date.addingTimeInterval(-31 * 86400),
                                                                             anchor: Data("old-\(selection.id)".utf8))
        }
        return state
    }

    func testOnlyNativeRawHeartGetsANewReadKeyWithoutChangingFrozenRequestIdentity() throws {
        for device in [ExecutionDevice.iPhone, .watch] {
            var task = task(device: device)
            XCTAssertEqual(try SyncIdentity.fingerprint(task), try legacyFingerprint(task))
            XCTAssertNotEqual(try SyncIdentity.key(task, selection: heart, now: date).0, try legacyKey(task, heart))
            XCTAssertEqual(try SyncIdentity.key(task, selection: steps, now: date).0, try legacyKey(task, steps))
            XCTAssertEqual(try SyncIdentity.key(task, selection: heart, now: date).0,
                           try SyncIdentity.key(task, selection: heart, now: date.addingTimeInterval(86400)).0)
            task.export.format = "hea.v2"
            XCTAssertEqual(try SyncIdentity.key(task, selection: heart, now: date).0, try legacyKey(task, heart))
            task.export.format = "healthrelay.v1"; task.export.mode = .aggregate
            XCTAssertEqual(try SyncIdentity.key(task, selection: heart, now: date).0, try legacyKey(task, heart))
        }
    }

    func testUpgradeRestartsAnInterruptedCycleAndBackfillsHeartOnlyOnce() async throws {
        for device in [ExecutionDevice.iPhone, .watch] {
            let task = task(device: device), journal = journal(), reader = MigrationReader(), sender = MigrationSender()
            try journal.save(legacyState(task), for: task.id)
            let result = await SyncEngine(reader: reader, sender: sender, journal: journal, now: { self.date }).run(task)
            XCTAssertEqual(result.state, .succeeded)
            XCTAssertEqual(reader.reads.map(\.id), [heart.id, steps.id])
            XCTAssertNil(reader.reads.first?.anchor)
            XCTAssertEqual(reader.reads.last?.anchor, Data("old-\(steps.id)".utf8))
            XCTAssertEqual(sender.uploads.count, 1)
            let state = try journal.load(task.id)
            XCTAssertNil(state.checkpoints[try legacyKey(task, heart)])
            XCTAssertEqual(state.checkpoints[try SyncIdentity.key(task, selection: heart, now: date).0]?.anchor,
                           Data("new-\(heart.id)".utf8))
            _ = await SyncEngine(reader: reader, sender: sender, journal: journal, now: { self.date }).run(task)
            XCTAssertEqual(reader.reads[2].anchor, Data("new-\(heart.id)".utf8))
            XCTAssertEqual(sender.uploads.count, 1, "Confirmed series backfill must not repeat after restart")
        }
    }

    func testUpgradeConfirmsFrozenLegacyBodyBeforeReadingSeries() async throws {
        let task = task(), journal = journal(), trace = MigrationTrace()
        let reader = MigrationReader(trace: trace), sender = MigrationSender(trace: trace)
        var state = try legacyState(task)
        let body = Data("frozen legacy scalar heart payload".utf8)
        state.pending = PendingUpload(batchID: "legacy-heart", body: body, contentType: "application/json", recordCount: 1,
                                      checkpointKey: try legacyKey(task, heart), checkpoint: TypeCheckpoint(start: date.addingTimeInterval(-30 * 86400), anchor: Data("old-confirmed".utf8)),
                                      configurationFingerprint: try legacyFingerprint(task))
        try journal.save(state, for: task.id)
        let result = await SyncEngine(reader: reader, sender: sender, journal: journal, now: { self.date }).run(task)
        XCTAssertEqual(result.state, .succeeded)
        XCTAssertEqual(trace.events.first, "send:legacy-heart")
        XCTAssertEqual(sender.uploads.first?.body, body)
        XCTAssertEqual(sender.uploads.first?.batchID, "legacy-heart")
        XCTAssertEqual(reader.reads.first?.id, heart.id)
        XCTAssertNil(reader.reads.first?.anchor)
        XCTAssertEqual(sender.uploads.count, 2)
        XCTAssertNil(try journal.load(task.id).pending)
    }
}

@MainActor private final class MigrationTrace { var events: [String] = [] }

@MainActor private final class MigrationReader: HealthDataReader {
    struct Read { var id: String; var anchor: Data? }
    var reads: [Read] = []
    let trace: MigrationTrace?
    init(trace: MigrationTrace? = nil) { self.trace = trace }
    func read(task: AutomationConfig, selection: MetricSelection, checkpoint: TypeCheckpoint, limit: Int) async throws -> ReadPage {
        reads.append(Read(id: selection.id, anchor: checkpoint.anchor)); trace?.events.append("read:\(selection.id)")
        let records = checkpoint.anchor == nil ? [HealthRecord(op: .upsert, typeIdentifier: selection.id, recordId: "native-parent",
            start: "2026-10-22T00:00:00Z", end: "2026-10-22T00:05:00Z", source: RecordSource(id: "watch", name: "Watch"),
            payload: ["value": .number(60), "unit": .string("count/min"), "quantityCount": .number(2),
                      "series": .array([.object(["start": .string("2026-10-22T00:00:00Z"), "end": .string("2026-10-22T00:00:00Z"), "value": .number(60)]),
                                        .object(["start": .string("2026-10-22T00:05:00Z"), "end": .string("2026-10-22T00:05:00Z"), "value": .number(61)])])])] : []
        return ReadPage(records: records, anchor: Data("new-\(selection.id)".utf8), hasMore: false)
    }
}

@MainActor private final class MigrationSender: UploadSender {
    var uploads: [PendingUpload] = []
    let trace: MigrationTrace?
    init(trace: MigrationTrace? = nil) { self.trace = trace }
    func send(_ upload: PendingUpload, destination: HTTPDestination) async throws -> Int {
        uploads.append(upload); trace?.events.append("send:\(upload.batchID)"); return 204
    }
}
