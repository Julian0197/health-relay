import XCTest
@testable import HealthRelayCore

@MainActor final class SyncHistoryBrowserTests: XCTestCase {
    func testBrowserLoadsPagesAndResetsForResultFilter() async throws {
        let root = URL.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = SyncHistoryStore(file: root.appendingPathComponent("history.sqlite")), now = Date()
        let context = SyncHistoryContext(taskID: UUID(), taskName: "同步", device: .watch, kind: .daily)
        try store.apply((0..<75).map { i in SyncHistoryEvent(entryID: "entry\(i)", context: context,
            date: now.addingTimeInterval(-Double(i)), state: i < 55 ? .succeeded : .failed) })
        let model = SyncHistoryBrowser(store: store)
        await model.reload()
        XCTAssertEqual(model.entries.count, 50); XCTAssertNotNil(model.nextCursor); XCTAssertFalse(model.loading)
        await model.loadMore()
        XCTAssertEqual(model.entries.count, 75); XCTAssertNil(model.nextCursor)
        model.filter = .attention; await model.reload()
        XCTAssertEqual(model.entries.count, 20); XCTAssertTrue(model.entries.allSatisfy { $0.state == .failed })
        XCTAssertNil(model.error)
    }
    func testBrowserDistinguishesEmptyFromUnreadableHistoryAndCanRetry() async throws {
        let root = URL.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let blocked = root.appendingPathComponent("blocked")
        try Data("blocked".utf8).write(to: blocked)
        let store = SyncHistoryStore(file: blocked.appendingPathComponent("history.sqlite")), model = SyncHistoryBrowser(store: store)
        await model.reload()
        XCTAssertNotNil(model.error); XCTAssertTrue(model.entries.isEmpty); XCTAssertFalse(model.loading)
        try FileManager.default.removeItem(at: blocked)
        await model.reload()
        XCTAssertNil(model.error); XCTAssertTrue(model.entries.isEmpty)
    }
}
