import XCTest
@testable import HealthRelayCore

final class SyncHistoryTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_792_550_000)
    private func context(_ id: UUID = UUID()) -> SyncHistoryContext {
        SyncHistoryContext(taskID: id, taskName: "健康指标", device: .iPhone, kind: .daily, destinationHost: "receiver.example")
    }
    private func store() -> SyncHistoryStore {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        return SyncHistoryStore(file: dir.appendingPathComponent("history.sqlite"))
    }
    func testSummariesSeparateMeasurementTimeDeletionAndCumulativeWorkoutDuration() throws {
        let records = [
            HealthRecord(op: .upsert, typeIdentifier: "HKQuantityTypeIdentifierHeartRate", recordId: "h", start: "2026-10-20T01:00:00Z", end: "2026-10-20T01:01:00Z", payload: ["value": .number(72), "unit": .string("count/min"), "metadata": .object(["private": .string("do not copy")])]),
            HealthRecord(op: .delete, typeIdentifier: "HKQuantityTypeIdentifierHeartRate", recordId: "old"),
            HealthRecord(op: .upsert, typeIdentifier: "HKWorkoutType", recordId: "live", start: "2026-10-20T00:30:00Z", end: "2026-10-20T01:00:00Z", payload: ["durationSeconds": .number(600), "activityType": .number(37)]),
            HealthRecord(op: .upsert, typeIdentifier: "HKWorkoutType", recordId: "live", start: "2026-10-20T00:30:00Z", end: "2026-10-20T01:01:00Z", payload: ["durationSeconds": .number(660), "activityType": .number(37)]),
        ]
        let summary = SyncHistorySummary(records: records)
        XCTAssertEqual(summary.recordCount, 4)
        XCTAssertEqual(summary.deletions, 1)
        let heart = try XCTUnwrap(summary.metrics.first { $0.typeIdentifier.contains("HeartRate") })
        XCTAssertEqual(heart.latestValue, 72)
        XCTAssertEqual(heart.unit, "count/min")
        let workout = try XCTUnwrap(summary.metrics.first { $0.typeIdentifier == "HKWorkoutType" })
        XCTAssertEqual(workout.latestValue, 660, "Cumulative workout observations must never be added together")
        let bytes = String(decoding: try JSONEncoder().encode(summary), as: UTF8.self)
        XCTAssertFalse(bytes.contains("do not copy"))
        XCTAssertEqual(summary.measuredTo, AutomationConfig.parseDate("2026-10-20T01:01:00Z"))
    }
    func testSleepAndStepSummariesDoNotInventDailyScoresOrTotals() throws {
        let records = [
            HealthRecord(op: .upsert, typeIdentifier: "HKCategoryTypeIdentifierSleepAnalysis", recordId: "s", start: "2026-10-20T00:00:00Z", end: "2026-10-20T01:00:00Z", payload: ["value": .number(4)]),
            HealthRecord(op: .upsert, typeIdentifier: "HKQuantityTypeIdentifierStepCount", recordId: "a", start: "2026-10-20T01:00:00Z", payload: ["value": .number(100), "unit": .string("count")]),
            HealthRecord(op: .upsert, typeIdentifier: "HKQuantityTypeIdentifierStepCount", recordId: "b", start: "2026-10-20T02:00:00Z", payload: ["value": .number(50), "unit": .string("count")]),
        ]
        let summary = SyncHistorySummary(records: records)
        let sleep = try XCTUnwrap(summary.metrics.first { $0.typeIdentifier.contains("Sleep") })
        XCTAssertEqual(sleep.detail, "最新阶段：深度睡眠")
        XCTAssertNil(sleep.latestValue)
        let steps = try XCTUnwrap(summary.metrics.first { $0.typeIdentifier.contains("StepCount") })
        XCTAssertEqual(steps.latestValue, 50)
        XCTAssertTrue(steps.detail?.contains("本批") == true)
    }
    func testBatchRetryIsOneRowWithDistinctAttemptsAndRealConfirmationTime() throws {
        let store = store(), ctx = context(), summary = SyncHistorySummary(recordCount: 2)
        let queued = SyncHistoryEvent(id: "q", entryID: "batch", context: ctx, batchID: "b", date: now, state: .queued, summary: summary)
        let failed = SyncHistoryEvent(id: "f", entryID: "batch", context: ctx, batchID: "b", date: now.addingTimeInterval(1), state: .failed, summary: summary, attemptID: "attempt1", message: "离线")
        let succeeded = SyncHistoryEvent(id: "s", entryID: "batch", context: ctx, batchID: "b", date: now.addingTimeInterval(2), state: .succeeded, summary: summary, attemptID: "attempt2", httpStatus: 200)
        try store.apply([queued, failed, failed, succeeded, succeeded], now: now.addingTimeInterval(30))
        let page = try store.page(now: now.addingTimeInterval(30))
        XCTAssertEqual(page.entries.count, 1)
        XCTAssertEqual(page.entries[0].state, .succeeded)
        XCTAssertEqual(page.entries[0].confirmedAt, now.addingTimeInterval(2))
        let detail = try XCTUnwrap(store.detail("batch", now: now.addingTimeInterval(30)))
        XCTAssertEqual(detail.events.count, 3)
        XCTAssertEqual(detail.entry.attempts, 2)
        let restarted = SyncHistoryStore(file: store.file)
        XCTAssertEqual(try restarted.page(now: now.addingTimeInterval(40)).entries[0].confirmedAt, now.addingTimeInterval(2))
    }
    func testTwentyDayBoundaryFiltersAndTaskSnapshots() throws {
        let store = store(), a = context(), b = context()
        let boundary = now.addingTimeInterval(-20 * 86400)
        try store.apply([
            SyncHistoryEvent(id: "old", entryID: "old", context: a, date: boundary.addingTimeInterval(-1), state: .failed),
            SyncHistoryEvent(id: "edge", entryID: "edge", context: a, date: boundary, state: .succeeded),
            SyncHistoryEvent(id: "new", entryID: "new", context: b, date: now, state: .queued),
        ], now: now)
        XCTAssertEqual(try store.page(now: now).entries.map(\.id), ["new", "edge"])
        XCTAssertEqual(try store.page(taskID: a.taskID, now: now).entries.map(\.id), ["edge"])
        XCTAssertEqual(try store.page(filter: .success, now: now).entries.map(\.id), ["edge"])
        XCTAssertEqual(try store.page(filter: .attention, now: now).entries.map(\.id), ["new"])
        try store.prune(now: now.addingTimeInterval(1))
        XCTAssertNil(try store.detail("edge", now: now.addingTimeInterval(1)))
        XCTAssertEqual(try store.page(now: now.addingTimeInterval(1)).entries[0].context.taskName, "健康指标")
    }
    func testTwentyThousandEntriesUseStableFiftyRowPagination() throws {
        let store = store(), ctx = context()
        let events = (0..<20_000).map { i in SyncHistoryEvent(id: "e\(i)", entryID: String(format: "%06d", i), context: ctx, date: now.addingTimeInterval(-Double(i / 5)), state: .succeeded) }
        try store.apply(events, now: now)
        var cursor: SyncHistoryCursor?, ids: [String] = []
        repeat {
            let page = try store.page(cursor: cursor, now: now)
            XCTAssertLessThanOrEqual(page.entries.count, 50)
            ids += page.entries.map(\.id); cursor = page.nextCursor
        } while cursor != nil
        XCTAssertEqual(ids.count, 20_000)
        XCTAssertEqual(Set(ids).count, 20_000)
    }
    func testCorruptDatabaseIsNotReplacedWithAnEmptyHistory() throws {
        let store = store()
        try FileManager.default.createDirectory(at: store.file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("broken history".utf8).write(to: store.file)
        XCTAssertThrowsError(try store.page(now: now))
        XCTAssertEqual(try String(contentsOf: store.file, encoding: .utf8), "broken history")
    }

    func testRetentionKeepsAttemptTimelineWhileTheBatchStillHasRecentActivity() throws {
        let store = store(), ctx = context()
        try store.apply([SyncHistoryEvent(id: "queued", entryID: "active", context: ctx, date: now, state: .queued)], now: now)
        let retry = now.addingTimeInterval(19 * 86400)
        try store.apply([SyncHistoryEvent(id: "retry", entryID: "active", context: ctx, date: retry, state: .failed, attemptID: "a")], now: retry)
        try store.prune(now: now.addingTimeInterval(21 * 86400))
        let detail = try XCTUnwrap(store.detail("active", now: now.addingTimeInterval(21 * 86400)))
        XCTAssertEqual(Set(detail.events.map(\.id)), ["queued", "retry"])
    }

}
