import XCTest
@testable import HealthRelayCore

final class HealthSignaturePresetTests: XCTestCase {
    func testWatchSignaturePresetIsDisabledPortableAndValidOnWatch() throws {
        let tasks = try HealthSignaturePreset.watchConfigurations(endpoint: "https://example.com/ingest")
        XCTAssertEqual(tasks.count, 2)
        XCTAssertTrue(tasks.allSatisfy { $0.device == .watch && !$0.enabled })
        XCTAssertTrue(tasks.allSatisfy { $0.validationIssues(device: .watch).isEmpty })
        let snapshot = try WatchConfigurationSnapshot(tasks: tasks)
        XCTAssertEqual(snapshot.tasks.count, 2)
    }
    func testBothSignatureTasksBecomeDueAfterFiveMinutesForAutomaticTriggers() throws {
        let tasks = try HealthSignaturePreset.configurations(endpoint: "https://192.168.1.2:18443/ingest")
        let lastAttempt = Date(timeIntervalSince1970: 1_000_000)
        var state = SyncState(); state.lastAttempt = lastAttempt
        for task in tasks {
            XCTAssertTrue(task.execution.onDataChange)
            XCTAssertTrue(task.execution.onForeground)
            XCTAssertEqual(task.execution.periodicPolling, true)
            for (dirty, foreground, periodic) in [(true, false, false), (false, true, false), (false, false, true)] {
                let due = try XCTUnwrap(AutomationSchedule.nextDate(task.execution, state: state, dirty: dirty,
                    foregroundCheck: foreground, periodicCheck: periodic, now: lastAttempt))
                XCTAssertGreaterThan(due, lastAttempt.addingTimeInterval(299))
                XCTAssertLessThanOrEqual(due, lastAttempt.addingTimeInterval(300))
            }
        }
    }

    func testPresetIncludesThirtyDayHealthHistoryAndWorkoutExclusion() throws {
        let tasks = try HealthSignaturePreset.configurations(endpoint: "https://192.168.1.2:18443/ingest")
        XCTAssertEqual(tasks.count, 2)
        XCTAssertEqual(Set(tasks.map(\.id)).count, 2)
        for task in tasks {
            XCTAssertFalse(task.enabled)
            XCTAssertEqual(task.range.mode, .incremental)
            XCTAssertEqual(task.range.bootstrapDays, 30)
            XCTAssertEqual(task.export.format, "healthrelay.v1")
            XCTAssertEqual(task.destination.acknowledgement, .receipt)
            XCTAssertEqual(task.destination.requiredSecretHeaders, ["X-Acceptance-Key"])
            XCTAssertTrue(task.validationIssues().isEmpty)
        }
        let metrics = try XCTUnwrap(tasks.first { $0.data.family == .healthMetrics })
        XCTAssertTrue(Set(metrics.data.selections.map(\.id)).isSuperset(of: [
            "HKQuantityTypeIdentifierHeartRateVariabilityRMSSD", "HKQuantityTypeIdentifierHeartRate",
            "HKQuantityTypeIdentifierRestingHeartRate", "HKCategoryTypeIdentifierSleepAnalysis",
            "HKQuantityTypeIdentifierStepCount", "HKQuantityTypeIdentifierActiveEnergyBurned"]))
        let workouts = try XCTUnwrap(tasks.first { $0.data.family == .workout })
        XCTAssertEqual(workouts.data.selections.map(\.id), ["HKWorkoutType"])
        XCTAssertNotEqual(workouts.data.workoutOptions?.includeRoutes, true)
    }
    func testBothDevicesRequestRecoveryHRVWithoutSubstitutingSDNN() throws {
        for tasks in [try HealthSignaturePreset.configurations(endpoint: "https://example.com/ingest"),
                      try HealthSignaturePreset.watchConfigurations(endpoint: "https://example.com/ingest")] {
            let metrics = try XCTUnwrap(tasks.first { $0.data.family == .healthMetrics })
            let variability = metrics.data.selections.filter { $0.id.contains("HeartRateVariability") }
            XCTAssertEqual(variability.map(\.id), ["HKQuantityTypeIdentifierHeartRateVariabilityRMSSD"])
            XCTAssertEqual(variability.first?.unit, "ms")
        }
    }
    func testPresetRejectsUnencryptedOrCredentialBearingEndpoints() {
        for endpoint in ["http://192.168.1.2/ingest", "https://user:password@example.com/ingest", "invalid"] {
            XCTAssertThrowsError(try HealthSignaturePreset.configurations(endpoint: endpoint))
        }
    }
}
