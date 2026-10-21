import XCTest
import HealthRelayCore
@testable import HealthRelay

@MainActor final class SyncHistoryAppTests: XCTestCase {
    func testStartupMigratesOnlyLocalRecentLogsAndPreservesConfiguration() throws {
        let directory = URL.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        var task = AutomationConfig.newTask()
        task.destination.url = "https://receiver.example/ingest?private=synthetic-secret"
        task.name = "手机健康同步"
        let repository = ConfigurationRepository(fileURL: directory.appendingPathComponent("tasks.json"))
        try repository.save([task])
        let before = try Data(contentsOf: repository.fileURL)
        let journal = SyncJournal(directory: directory.appendingPathComponent("sync"))
        var state = SyncState()
        state.logs = [RunLog(state: .succeeded, message: "已确认 5 条", records: 5), RunLog(state: .noData, message: "无新数据")]
        try journal.save(state, for: task.id)
        let store = AutomationStore(directory: directory, protectedDataAvailable: { true })
        let rows = try store.history.page().entries
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].context.taskID, task.id)
        XCTAssertTrue(rows[0].legacy)
        XCTAssertEqual(rows[0].summary.recordCount, 5)
        XCTAssertEqual(try Data(contentsOf: repository.fileURL), before)
        XCTAssertFalse(String(decoding: try JSONEncoder().encode(rows), as: UTF8.self).contains("synthetic-secret"))
        let restarted = AutomationStore(directory: directory, protectedDataAvailable: { true })
        XCTAssertEqual(try restarted.history.page().entries.count, 1)
    }
}
