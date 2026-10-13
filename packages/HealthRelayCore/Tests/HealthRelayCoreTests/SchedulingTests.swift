import Foundation
import XCTest
@testable import HealthRelayCore

final class SchedulingTests: XCTestCase {
    let now = Date(timeIntervalSince1970: 1_000_000)

    func testPeriodicWakeUsesLastAttemptAndDoesNotDriftWhenReplanned() {
        var settings = ExecutionSettings(); settings.periodicPolling = true
        var state = SyncState(); state.lastAttempt = now
        let due = now.addingTimeInterval(1800)
        XCTAssertEqual(AutomationSchedule.nextDate(settings, state: state, now: now), due)
        XCTAssertEqual(AutomationSchedule.nextDate(settings, state: state, now: now.addingTimeInterval(100)), due)
    }

    func testIdleDataChangeTaskDoesNotPollButDirtyTaskWakesAfterThrottle() {
        var state = SyncState(); state.lastAttempt = now
        let settings = ExecutionSettings()
        XCTAssertNil(AutomationSchedule.nextDate(settings, state: state, now: now))
        XCTAssertEqual(AutomationSchedule.nextDate(settings, state: state, dirty: true, now: now), now.addingTimeInterval(1800))
        XCTAssertEqual(AutomationSchedule.nextDate(settings, state: state, foregroundCheck: true, now: now), now.addingTimeInterval(1800))
        var disabled = settings; disabled.onForeground = false
        XCTAssertNil(AutomationSchedule.nextDate(disabled, state: state, foregroundCheck: true, now: now))
    }

    func testNewPeriodicTaskRunsImmediately() {
        var settings = ExecutionSettings(); settings.periodicPolling = true
        XCTAssertEqual(AutomationSchedule.nextDate(settings, state: SyncState(), now: now), now)
    }

    func testUnrelatedHealthChangeDoesNotRunPeriodicOnlyTask() {
        var settings = ExecutionSettings(); settings.periodicPolling = true; settings.onDataChange = false
        XCTAssertNil(AutomationSchedule.nextDate(settings, state: SyncState(), periodicCheck: false, now: now))
        XCTAssertEqual(AutomationSchedule.nextDate(settings, state: SyncState(), now: now), now)
    }

    func testContinuationAndBackfillWakeWithoutPollingAndBackOffReadFailures() {
        var state = SyncState(); state.lastAttempt = now; state.nextSelectionID = "steps"
        let settings = ExecutionSettings()
        XCTAssertEqual(AutomationSchedule.nextDate(settings, state: state, now: now), now.addingTimeInterval(1))
        state.logs = [RunLog(state: .failed, message: "locked")]
        XCTAssertEqual(AutomationSchedule.nextDate(settings, state: state, now: now), now.addingTimeInterval(300))
        state.nextSelectionID = nil; state.logs = []
        XCTAssertEqual(AutomationSchedule.nextDate(settings, state: state, backfill: true, now: now), now.addingTimeInterval(1))
    }

    func testRetryAfterAndManualOnlyRetryTakePriorityOverAllTriggers() {
        var state = SyncState()
        state.pending = PendingUpload(batchID: "batch", body: Data(), contentType: "application/json", recordCount: 1,
            checkpointKey: "key", checkpoint: TypeCheckpoint(start: now), configurationFingerprint: "fingerprint")
        state.pending?.nextAttempt = now.addingTimeInterval(120)
        var settings = ExecutionSettings(); settings.periodicPolling = true
        XCTAssertEqual(AutomationSchedule.nextDate(settings, state: state, dirty: true, foregroundCheck: true, now: now), now.addingTimeInterval(120))
        state.pending?.automaticRetry = false
        XCTAssertNil(AutomationSchedule.nextDate(settings, state: state, dirty: true, foregroundCheck: true, backfill: true, now: now))
    }
}
