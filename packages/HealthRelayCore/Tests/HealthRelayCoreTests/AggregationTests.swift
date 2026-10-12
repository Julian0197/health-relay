import XCTest
@testable import HealthRelayCore

@MainActor final class AggregationTests: XCTestCase {
    func task() -> AutomationConfig {
        var t = AutomationConfig.newTask()
        t.destination.url = "https://receiver.example/ingest"
        t.data.selections = [MetricSelection(typeIdentifier: "HKQuantityTypeIdentifierStepCount", unit: "count"), MetricSelection(typeIdentifier: "HKQuantityTypeIdentifierHeartRate", unit: "count/min")]
        t.export.mode = .aggregate; t.export.grouping = .hours; t.export.timeZone = "UTC"
        return t
    }
    func testMixedMetricsUseIndependentDefaults() {
        let t = task()
        XCTAssertEqual(t.validationIssues(), [])
        XCTAssertFalse(t.executionIssues.contains { $0.contains("汇总执行") })
    }
    func testExplicitEmptyStatisticsDoesNotSilentlyRestoreDefaults() {
        var t = task(); t.data.selections[0].statistics = []
        XCTAssertFalse(t.validationIssues().isEmpty)
    }
    func testSleepCanShareAnAggregateTask() {
        var t = task()
        t.data.selections.append(MetricSelection(typeIdentifier: "HKCategoryTypeIdentifierSleepAnalysis"))
        XCTAssertEqual(t.validationIssues(), [])
    }
}

@MainActor final class AggregateWindowTests: XCTestCase {
    func date(_ s: String) -> Date { AutomationConfig.parseDate(s)! }
    func task() -> AutomationConfig {
        var t = AutomationConfig.newTask(); t.export.mode = .aggregate; t.export.grouping = .hours; t.export.timeZone = "UTC"
        t.data.selections = [MetricSelection(typeIdentifier: "HKQuantityTypeIdentifierHeartRate", unit: "count/min")]
        return t
    }
    func testDSTAndSleepDayBoundaries() throws {
        let day = try AggregateWindow.containing(date("2026-03-08T12:00:00Z"), grouping: .days, timeZone: "America/Los_Angeles")
        XCTAssertEqual(day.end.timeIntervalSince(day.start), 23 * 3600)
        let evening = try AggregateWindow.containing(date("2026-10-11T22:00:00Z"), grouping: .days, timeZone: "UTC", sleep: true)
        let morning = try AggregateWindow.containing(date("2026-10-12T07:00:00Z"), grouping: .days, timeZone: "UTC", sleep: true)
        XCTAssertEqual(evening, morning)
    }
    func testLateChangeDeletionAndNoChangeSnapshotReuse() async throws {
        let t = task(), selection = t.data.selections[0], source = WindowSource()
        let reader = AggregationReader(source: source)
        var checkpoint = TypeCheckpoint(start: date("2026-10-12T00:00:00Z"))
        source.events = [source.sample("a", value: 60)]; source.values = [60]
        let first = try await reader.read(task: t, selection: selection, checkpoint: checkpoint, limit: 10)
        checkpoint = try XCTUnwrap(first.checkpoint)
        source.events = []; let before = source.snapshots
        let empty = try await reader.read(task: t, selection: selection, checkpoint: checkpoint, limit: 10)
        XCTAssertTrue(empty.records.isEmpty); XCTAssertEqual(source.snapshots, before)
        source.events = [source.sample("b", value: 80)]; source.values = [60,80]
        let corrected = try await reader.read(task: t, selection: selection, checkpoint: checkpoint, limit: 10)
        XCTAssertEqual(first.records[0].recordId, corrected.records[0].recordId)
        XCTAssertEqual(corrected.records[0].payload?["value"], .number(70))
        checkpoint = try XCTUnwrap(corrected.checkpoint)
        source.events = [HealthRecord(op: .delete, typeIdentifier: selection.id, recordId: "a")]; source.values = [80]
        let removed = try await reader.read(task: t, selection: selection, checkpoint: checkpoint, limit: 10)
        XCTAssertEqual(removed.records.first?.payload?["value"], .number(80))
        XCTAssertEqual(removed.records.first?.recordId, first.records[0].recordId)
    }
    func testOverlappingLongSampleOnlyRebuildsRequestedWindows() async throws {
        let t = task(), source = WindowSource()
        source.events = [HealthRecord(op: .upsert, typeIdentifier: t.data.selections[0].id, recordId: "long", start: "2026-10-12T00:00:00Z", end: "2026-10-12T04:00:00Z")]
        source.values = [60]
        let checkpoint = TypeCheckpoint(start: date("2026-10-12T01:30:00Z"), end: date("2026-10-12T02:30:00Z"))
        let page = try await AggregationReader(source: source).read(task: t, selection: t.data.selections[0], checkpoint: checkpoint, limit: 10)
        XCTAssertEqual(page.records.map(\.start), ["2026-10-12T01:00:00.000Z", "2026-10-12T02:00:00.000Z"])
    }
    func testUnknownDeletionSweepIsBoundedAndExcludesFixedEnd() async throws {
        let t = task(), source = WindowSource()
        source.events = [HealthRecord(op: .delete, typeIdentifier: t.data.selections[0].id, recordId: "evicted")]
        let checkpoint = TypeCheckpoint(start: date("2026-10-12T00:00:00Z"), end: date("2026-10-12T03:00:00Z"))
        let reader = AggregationReader(source: source, now: { self.date("2026-10-12T05:00:00Z") })
        let first = try await reader.read(task: t, selection: t.data.selections[0], checkpoint: checkpoint, limit: 2)
        XCTAssertEqual(first.records.count, 2); XCTAssertTrue(first.hasMore)
        XCTAssertTrue(first.records.allSatisfy { $0.op == .delete })
        let second = try await reader.read(task: t, selection: t.data.selections[0], checkpoint: try XCTUnwrap(first.checkpoint), limit: 2)
        XCTAssertEqual(second.records.count, 1); XCTAssertFalse(second.hasMore)
        XCTAssertEqual(second.records.first?.end, "2026-10-12T03:00:00.000Z")
    }
    func testSleepOverlapIsNotDoubleCounted() throws {
        let w = try AggregateWindow.containing(date("2026-10-12T02:00:00Z"), grouping: .days, timeZone: "UTC", sleep: true)
        func sample(_ id: String, _ start: String, _ end: String, _ stage: Double) -> HealthRecord {
            HealthRecord(op:.upsert,typeIdentifier:"HKCategoryTypeIdentifierSleepAnalysis",recordId:id,start:start,end:end,payload:["value":.number(stage)])
        }
        let records = [sample("whole","2026-10-11T23:00:00Z","2026-10-12T07:00:00Z",1),sample("core","2026-10-12T00:00:00Z","2026-10-12T06:00:00Z",3),sample("duplicate","2026-10-12T00:00:00Z","2026-10-12T06:00:00Z",3)]
        let payload = try XCTUnwrap(SleepSummary.payload(records:records,window:w,timeZone:"UTC"))
        XCTAssertEqual(payload["totalSleep"], .number(8)); XCTAssertEqual(payload["core"], .number(6))
        XCTAssertEqual(payload["sleepDate"], .string("2026-10-12"))
    }
}
@MainActor private final class WindowSource: AggregateSource {
    var events: [HealthRecord] = []; var values: [Double] = []; var snapshots = 0
    func sample(_ id: String, value: Double) -> HealthRecord {
        HealthRecord(op:.upsert,typeIdentifier:"HKQuantityTypeIdentifierHeartRate",recordId:id,start:"2026-10-12T01:15:00Z",end:"2026-10-12T01:15:00Z",payload:["value":.number(value)])
    }
    func readChanges(task: AutomationConfig, selection: MetricSelection, checkpoint: TypeCheckpoint, limit: Int) async throws -> ReadPage {
        ReadPage(records:events,anchor:Data(UUID().uuidString.utf8),hasMore:false)
    }
    func snapshot(task: AutomationConfig, selection: MetricSelection, window: AggregateWindow) async throws -> [String: JSONValue]? {
        snapshots += 1
        if values.isEmpty { return nil }
        return ["aggregation":.bool(true),"unit":.string("count/min"),"value":.number(values.reduce(0,+)/Double(values.count))]
    }
}
