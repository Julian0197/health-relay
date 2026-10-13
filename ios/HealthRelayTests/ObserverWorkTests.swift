import XCTest
import HealthRelayCore
@testable import HealthRelay

@MainActor final class ObserverWorkTests: XCTestCase {
    func testCompletionWaitsForProcessing() async throws {
        var events: [String] = []
        let gate = RunCoordinator()
        await gate.acquire()
        let completion = ObserverCompletion { events.append("complete") }
        let work = ObserverWork.start(completion: completion) {
            await gate.acquire(); defer { gate.release() }
            events.append("processed")
        }
        try await Task.sleep(for: .milliseconds(30))
        XCTAssertEqual(events, [], "HealthKit must retain its execution window while processing")
        gate.release()
        await work.value
        try await Task.sleep(for: .milliseconds(10))
        XCTAssertEqual(events, ["processed", "complete"])
    }

    func testTimeoutCompletesOnceEvenWhileCoordinatorIsBlocked() async throws {
        let gate = RunCoordinator()
        await gate.acquire()
        var completions = 0, performed = false
        let completion = ObserverCompletion { completions += 1 }
        let work = ObserverWork.start(timeout: .milliseconds(25), completion: completion) {
            await gate.acquire(); defer { gate.release() }
            guard !Task.isCancelled else { return }
            performed = true
        }
        try await Task.sleep(for: .milliseconds(75))
        XCTAssertEqual(completions, 1)
        gate.release()
        await work.value
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertFalse(performed, "Expired work must not read or upload after acquiring the gate")
        XCTAssertEqual(completions, 1)
    }

    func testTimeoutSchedulesRecoveryBeforeReleasingHealthKitWindow() async throws {
        var events: [String] = []
        let work = ObserverWork.start(timeout: .milliseconds(20),
            completion: ObserverCompletion { events.append("complete") },
            onTimeout: { events.append("retryScheduled") }) {
                try? await Task.sleep(for: .seconds(10))
            }
        try await Task.sleep(for: .milliseconds(60))
        await work.value
        XCTAssertEqual(events, ["retryScheduled", "complete"])
    }

    func testNormalFinishCancelsDeadlineAndCompletesOnlyOnce() async throws {
        var completions = 0
        let work = ObserverWork.start(timeout: .milliseconds(25),
            completion: ObserverCompletion { completions += 1 }) {}
        await work.value
        try await Task.sleep(for: .milliseconds(75))
        XCTAssertEqual(completions, 1)
    }
}
