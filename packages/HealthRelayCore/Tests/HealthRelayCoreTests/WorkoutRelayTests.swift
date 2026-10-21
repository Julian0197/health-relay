import XCTest
@testable import HealthRelayCore

@MainActor final class WorkoutRelayTests: XCTestCase {
    let now = Date(timeIntervalSince1970: 1_790_000_000)
    func fixture() throws -> (URL, AutomationConfig) {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        var task = try HealthSignaturePreset.configurations(endpoint: "https://example.com/ingest").last!
        task.device = .watch; task.enabled = true
        task.destination.requiredSecretHeaders = nil
        return (dir, task)
    }
    func testPendingBodySurvivesRestartAndNewSamplesCannotReplaceIt() throws {
        let (dir, task) = try fixture()
        let relay = WorkoutRelayOutbox(directory: dir)
        try relay.begin(task: task)
        let record = try WorkoutLiveSample(sessionID: task.id, start: now, observedAt: now.addingTimeInterval(60),
            elapsedSeconds: 50, activityType: 50, state: .running, heartRate: 80, heartMeasuredAt: now.addingTimeInterval(55)).record()
        try relay.offer([record], terminal: false)
        let first = try XCTUnwrap(relay.prepare(now: now))
        try relay.offer([record], terminal: true)
        XCTAssertThrowsError(try relay.offer([record], terminal: false), "A delayed timer cannot overwrite final completion")
        let restored = WorkoutRelayOutbox(directory: dir)
        XCTAssertEqual(try restored.prepare(now: now)?.body, first.body)
        XCTAssertThrowsError(try restored.begin(task: task), "Cannot lose an unfinished previous session")
        let identity = BatchIdentity(taskID: task.id, batchID: first.batchID, fingerprint: first.configurationFingerprint)
        let receipt = Data("{\"batchId\":\"\(first.batchID)\",\"committed\":true,\"accepted\":1,\"duplicates\":0}".utf8)
        XCTAssertTrue(try restored.confirm(identity, status: 200, data: receipt, now: now))
        let final = try XCTUnwrap(restored.prepare(now: now), "Newer terminal snapshot must survive an older receipt")
        let finalIdentity = BatchIdentity(taskID: task.id, batchID: final.batchID, fingerprint: final.configurationFingerprint)
        let finalReceipt = Data("{\"batchId\":\"\(final.batchID)\",\"committed\":true,\"accepted\":1,\"duplicates\":0}".utf8)
        XCTAssertTrue(try restored.confirm(finalIdentity, status: 200, data: finalReceipt, now: now))
        XCTAssertFalse(try restored.hasUnsentRecords())
        XCTAssertNil(try restored.prepare(now: now))
        XCTAssertNoThrow(try restored.begin(task: task))
    }
    func testExplicitRetryCanResendAnUnchangedBatchAfterAnUnretryableFailure() throws {
        let (dir, task) = try fixture(), relay = WorkoutRelayOutbox(directory: dir)
        try relay.begin(task: task)
        let record = try WorkoutLiveSample(sessionID: task.id, start: now, observedAt: now,
            elapsedSeconds: 0, activityType: 50, state: .running).record()
        try relay.offer([record], terminal: false)
        let pending = try XCTUnwrap(relay.prepare(now: now))
        let identity = BatchIdentity(taskID: task.id, batchID: pending.batchID, fingerprint: pending.configurationFingerprint)
        try relay.fail(identity, failure: UploadFailure("Service rejected", retryable: false, status: 422))
        XCTAssertNil(try relay.prepare(now: now))
        XCTAssertEqual(try relay.prepare(now: now, automatic: false)?.body, pending.body)
    }
    func testLivePayloadUsesRealMeasurementTimeAndFinalReplacementDeletesProvisionalRecord() throws {
        let sample = WorkoutLiveSample(sessionID: UUID(), start: now, observedAt: now.addingTimeInterval(60),
            elapsedSeconds: 45, activityType: 50, state: .paused, heartRate: 82, heartMeasuredAt: now.addingTimeInterval(52))
        let record = try sample.record()
        XCTAssertEqual(record.typeIdentifier, "HKWorkoutType")
        XCTAssertEqual(record.payload?["durationSeconds"], .number(45))
        let completed = HealthRecord(op: .upsert, typeIdentifier: "HKWorkoutType", recordId: "native-workout")
        let replacement = sample.replacing(with: completed)
        XCTAssertEqual(replacement.map(\.op), [.delete, .upsert])
        XCTAssertEqual(replacement.first?.recordId, record.recordId)
        if case .object(let live)? = replacement.last?.payload?["live"] { XCTAssertEqual(live["state"], .string("ended")) }
        else { XCTFail("Final record retains actual heart evidence") }
        var fractional = sample; fractional.observedAt = now.addingTimeInterval(0.9); fractional.elapsedSeconds = 0.8
        fractional.heartMeasuredAt = now.addingTimeInterval(0.5)
        XCTAssertNoThrow(try fractional.record())
        var invalid = sample; invalid.elapsedSeconds = 90
        XCTAssertThrowsError(try invalid.record())
    }
}
