import XCTest

final class SyncHistoryUITests: XCTestCase {
    @MainActor func testHistoryNavigationFiltersAndOfflineDetail() throws {
        let app = launch("full")
        let first = app.buttons["history-entry-ui-0"]
        XCTAssertTrue(first.waitForExistence(timeout: 10))
        capture(app, "iOS 同步历史列表")
        first.tap()
        XCTAssertTrue(app.staticTexts["同步时间（回执确认）"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["排队时间"].exists)
        capture(app, "iOS 同步详情与确认时间")
        app.navigationBars.buttons.firstMatch.tap()
        app.segmentedControls.buttons["待处理与异常"].tap()
        XCTAssertTrue(app.buttons["history-entry-ui-1"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["history-entry-ui-0"].exists)
        capture(app, "iOS 异常筛选")
        app.segmentedControls.buttons["成功"].tap()
        XCTAssertTrue(first.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["history-entry-ui-1"].exists)
        // Relaunch without a fixture to prove history survives app termination offline.
        app.terminate(); app.launchArguments = ["--ui-testing"]; app.launch()
        app.buttons["sync-history"].tap()
        XCTAssertTrue(first.waitForExistence(timeout: 10))
    }
    @MainActor func testEmptyAndUnreadableHistoryAreDistinct() throws {
        let app = launch("empty")
        XCTAssertTrue(app.staticTexts["暂无同步历史"].waitForExistence(timeout: 10))
        capture(app, "iOS 空记录")
        app.terminate()
        app.launchArguments = ["--ui-testing", "--history-fixture=error"]; app.launch()
        app.buttons["sync-history"].tap()
        XCTAssertTrue(app.buttons["history-retry"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["暂无同步历史"].exists)
        capture(app, "iOS 历史读取错误")
    }
    @MainActor private func launch(_ mode: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--reset-configurations", "--history-fixture=\(mode)"]
        app.launch()
        XCTAssertTrue(app.buttons["sync-history"].waitForExistence(timeout: 10))
        app.buttons["sync-history"].tap()
        return app
    }
    @MainActor private func capture(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot()); attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
}
