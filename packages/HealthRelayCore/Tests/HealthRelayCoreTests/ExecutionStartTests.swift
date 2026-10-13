import Foundation
import XCTest
@testable import HealthRelayCore

final class ExecutionStartTests: XCTestCase {
    private func task(_ type: String = "BodyMass", unit: String = "kg") -> AutomationConfig {
        var task = AutomationConfig.newTask()
        task.destination.url = "https://receiver.example/ingest"
        task.export.format = "hea.csv"; task.export.mode = .aggregate; task.export.grouping = .days
        task.data.selections = [MetricSelection(typeIdentifier: "HKQuantityTypeIdentifier" + type, unit: unit)]
        return task
    }
    private func pending(_ task: AutomationConfig) throws -> PendingUpload {
        PendingUpload(batchID: "frozen-csv", body: Data("legacy frozen bytes".utf8), contentType: "multipart/form-data; boundary=legacy",
                      recordCount: 1, checkpointKey: "checkpoint", checkpoint: TypeCheckpoint(start: Date(timeIntervalSince1970: 0)),
                      configurationFingerprint: try SyncIdentity.fingerprint(task))
    }
    func testMatchingFrozenLegacyBatchCanStartDespiteNewReadCapabilityGate() throws {
        for configured in [task(), task("HeartRateVariabilityRMSSD", unit: "ms")] {
            XCTAssertFalse(configured.executionIssues.isEmpty)
            XCTAssertTrue(configured.executionStartIssues(pending: try pending(configured)).isEmpty)
        }
    }
    func testLegacyConfigurationWithoutPendingRemainsBlocked() {
        let configured = task()
        XCTAssertTrue(configured.executionStartIssues(pending: nil).contains { $0.contains("统计") })
    }
    func testChangedConfigurationCannotStartFrozenBatch() throws {
        var configured = task("StepCount", unit: "count")
        let frozen = try pending(configured)
        configured.destination.url = "https://other.example/ingest"
        XCTAssertTrue(configured.executionIssues.isEmpty)
        XCTAssertTrue(configured.executionStartIssues(pending: frozen).contains { $0.contains("待上传批次") })
    }
    func testMatchingPendingStillRequiresDestinationCredentials() throws {
        var configured = task()
        configured.destination.credentialHeader = "Authorization"
        XCTAssertTrue(configured.executionStartIssues(pending: try pending(configured)).contains { $0.contains("认证值") })
        configured.destination.credentialHeader = nil
        configured.destination.requiredSecretHeaders = ["X-API-Key"]
        XCTAssertTrue(configured.executionStartIssues(pending: try pending(configured)).contains { $0.contains("认证值") })
    }
    func testMatchingPendingStillRequiresValidConfigurationAndRuntimeSupport() throws {
        var configured = task()
        configured.destination.url = "http://receiver.example/ingest"
        XCTAssertTrue(configured.executionStartIssues(pending: try pending(configured)).contains { $0.contains("HTTPS") })
        configured = task("HeartRateVariabilityRMSSD", unit: "ms")
        XCTAssertTrue(configured.executionStartIssues(pending: try pending(configured), systemMajorVersion: 18).contains { $0.contains("需要 iOS") })
    }
    func testSupportedFreshConfigurationCanStart() {
        XCTAssertTrue(task("StepCount", unit: "count").executionStartIssues(pending: nil).isEmpty)
    }
    func testDisabledWatchCanOnlyManuallyRetryAnExistingMatchingBatch() throws {
        var configured = task("StepCount", unit: "count"); configured.device = .watch; configured.enabled = false
        let frozen = try pending(configured)
        XCTAssertTrue(configured.executionStartIssues(pending: frozen).isEmpty)
        XCTAssertTrue(configured.executionStartIssues(pending: nil).contains { $0.contains("启用") })
        XCTAssertTrue(configured.executionStartIssues(pending: frozen, automatic: true).contains { $0.contains("启用") })
        configured.destination.url = "https://other.example/ingest"
        XCTAssertTrue(configured.executionStartIssues(pending: frozen).contains { $0.contains("待上传批次") })
    }
    func testEnabledWatchFreshRunsRemainEligibleForManualAndAutomaticExecution() {
        var configured = task("StepCount", unit: "count"); configured.device = .watch; configured.enabled = true
        XCTAssertTrue(configured.executionStartIssues(pending: nil).isEmpty)
        XCTAssertTrue(configured.executionStartIssues(pending: nil, automatic: true).isEmpty)
    }

}
