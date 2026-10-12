import XCTest
@testable import HealthRelayCore

@MainActor final class ExecutionCoreTests: XCTestCase {
    func task() -> AutomationConfig {
        var t = AutomationConfig.newTask(); t.destination.url = "https://receiver.example/ingest"
        t.data.selections = [MetricSelection(typeIdentifier:"HKQuantityTypeIdentifierBodyMass",unit:"kg"),MetricSelection(typeIdentifier:"HKQuantityTypeIdentifierStepCount",unit:"count")]
        return t
    }
    func testBudgetStopsBetweenSinglePageMetricsAndResumesNextType() async throws {
        let t = task(), reader = BudgetReader(), sender = BudgetSender()
        let journal = SyncJournal(directory:FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString))
        let engine = SyncEngine(reader:reader,sender:sender,journal:journal,now: { sender.clock })
        let first = await engine.run(t,timeBudget:1)
        XCTAssertEqual(first.state,.queued); XCTAssertEqual(reader.types,[t.data.selections[0].id])
        let second = await engine.run(t,timeBudget:5)
        XCTAssertEqual(second.state,.succeeded); XCTAssertEqual(reader.types,[t.data.selections[0].id,t.data.selections[1].id])
        XCTAssertEqual(try journal.load(t.id).checkpoints.count,2)
    }
    func testCalendarRangeStaysFrozenWhenContinuationCrossesMidnight() async throws {
        var t = task(); t.range.mode = .today; t.export.timeZone = "UTC"
        let reader = BudgetReader(), sender = BudgetSender()
        sender.clock = AutomationConfig.parseDate("2026-10-12T23:59:59Z")!
        let journal = SyncJournal(directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString))
        let engine = SyncEngine(reader: reader, sender: sender, journal: journal, now: { sender.clock })
        _ = await engine.run(t, timeBudget: 1)
        _ = await engine.run(t, timeBudget: 5)
        XCTAssertEqual(reader.starts, [AutomationConfig.parseDate("2026-10-12T00:00:00Z")!, AutomationConfig.parseDate("2026-10-12T00:00:00Z")!])
        _ = await engine.run(t, timeBudget: 5)
        XCTAssertEqual(reader.starts.last, AutomationConfig.parseDate("2026-10-13T00:00:00Z")!)
    }
    func testBackfillHasSeparateProgressAndKeepsOutboundTaskIdentity() async throws {
        let t = task(), reader = BudgetReader(), sender = BudgetSender()
        let journal = SyncJournal(directory:FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString))
        let engine = SyncEngine(reader:reader,sender:sender,journal:journal)
        var parent = SyncState(); parent.lastConfirmedAt = Date(timeIntervalSince1970:123)
        try journal.save(parent,for:t.id)
        let before = try Data(contentsOf: journal.directory.appendingPathComponent(t.id.uuidString + ".json"))
        let job = try BackfillJob(task:t,start:Date(timeIntervalSince1970:0),end:Date(timeIntervalSince1970:3600))
        _ = await engine.run(job.task,storageID:job.id)
        XCTAssertEqual(before,try Data(contentsOf:journal.directory.appendingPathComponent(t.id.uuidString + ".json")))
        XCTAssertEqual(try JSONDecoder().decode(UploadBatch.self,from:sender.uploads[0].body).taskId,t.id)
        XCTAssertNotNil(try journal.load(job.id).lastConfirmedAt)
    }
    func testHEADeletionPolicyIsExplicitAndOmissionAdvancesCheckpoint() async throws {
        var t = task(); t.data.selections = [t.data.selections[0]]; t.export.format = "hea.v2"
        let reader = DeletedRecordReader(), sender = BudgetSender()
        let journal = SyncJournal(directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString))
        let engine = SyncEngine(reader: reader, sender: sender, journal: journal)
        let rejected = await engine.run(t)
        XCTAssertEqual(rejected.state, .failed); XCTAssertTrue(try journal.load(t.id).checkpoints.isEmpty)
        t.export.deletionPolicy = .omit
        let skipped = await engine.run(t)
        XCTAssertEqual(skipped.state, .noData); XCTAssertEqual(skipped.omittedDeletions, 1)
        XCTAssertFalse(try journal.load(t.id).checkpoints.isEmpty); XCTAssertTrue(sender.uploads.isEmpty)
        let repeated = await engine.run(t)
        XCTAssertEqual(repeated.omittedDeletions, 0)
    }
    func testCancelledWaiterDoesNotRunOrLeakGlobalPermit() async {
        let gate = RunCoordinator(); await gate.acquire()
        var ran = false
        let waiter = Task {
            await gate.acquire(); defer { gate.release() }
            guard !Task.isCancelled else { return }; ran = true
        }
        await Task.yield(); waiter.cancel(); gate.release(); await waiter.value
        await gate.acquire(); gate.release()
        XCTAssertFalse(ran)
    }
    func testGlobalGateSerializesConcurrentWork() async throws {
        let gate = RunCoordinator(); var count = 0, maximum = 0
        let work: () async -> Void = {
            await gate.acquire(); defer { gate.release() }
            count += 1; maximum = max(maximum,count)
            try? await Task.sleep(for:.milliseconds(5)); count -= 1
        }
        let a = Task { await work() }, b = Task { await work() }
        await a.value; await b.value
        XCTAssertEqual(maximum,1)
    }
}
@MainActor private final class BudgetReader: HealthDataReader {
    var types:[String] = []; var starts: [Date] = []
    func read(task:AutomationConfig,selection:MetricSelection,checkpoint:TypeCheckpoint,limit:Int) async throws -> ReadPage {
        types.append(selection.id); starts.append(checkpoint.start)
        let r=HealthRecord(op:.upsert,typeIdentifier:selection.id,recordId:selection.id,start:"2026-10-12T00:00:00Z",end:"2026-10-12T00:00:00Z",payload:["value":.number(1),"unit":.string(selection.unit!)])
        return ReadPage(records:checkpoint.anchor == nil ? [r]:[],anchor:Data("next".utf8),hasMore:false)
    }
}
@MainActor private final class BudgetSender: UploadSender {
    var clock=Date(); var uploads:[PendingUpload]=[]
    func send(_ upload:PendingUpload,destination:HTTPDestination) async throws -> Int { uploads.append(upload); clock=clock.addingTimeInterval(2);return 200 }
}

final class RetryAfterTests: XCTestCase {
    func testSecondsAndHTTPDate() {
        let now = Date(timeIntervalSince1970: 1_445_412_460)
        XCTAssertEqual(HTTPAcknowledgement.retryDelay("120", now: now), 120)
        XCTAssertEqual(HTTPAcknowledgement.retryDelay("Wed, 21 Oct 2015 07:28:00 GMT", now: now), 20)
        XCTAssertNil(HTTPAcknowledgement.retryDelay("invalid", now: now))
    }
}

@MainActor private final class DeletedRecordReader: HealthDataReader {
    func read(task: AutomationConfig, selection: MetricSelection, checkpoint: TypeCheckpoint, limit: Int) async throws -> ReadPage {
        ReadPage(records: checkpoint.anchor == nil ? [HealthRecord(op: .delete, typeIdentifier: selection.id, recordId: "deleted")] : [], anchor: Data("end".utf8), hasMore: false)
    }
}
