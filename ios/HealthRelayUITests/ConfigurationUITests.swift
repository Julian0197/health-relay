import XCTest

final class ConfigurationUITests: XCTestCase {
    @MainActor
    func testCreateAndPersistGenericTask() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--reset-configurations"]
        app.launch()
        XCTAssertTrue(app.buttons["new-task"].waitForExistence(timeout: 10))
        app.buttons["new-task"].tap()
        let name = app.textFields["task-name"]
        XCTAssertTrue(name.waitForExistence(timeout: 5))
        name.tap()
        // Clear the default using the current field contents, independent of localization.
        name.tap()
        if let value = name.value as? String, !value.isEmpty {
            name.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: value.count))
        }
        name.typeText("通用配置验收")
        app.buttons["metric-picker"].tap()
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap(); search.typeText("BodyMass")
        let metric = app.buttons["metric-HKQuantityTypeIdentifierBodyMass"]
        XCTAssertTrue(metric.waitForExistence(timeout: 5)); metric.tap()
        capture(app, "指标选择")
        app.buttons["metrics-done"].tap()
        let endpoint = app.textFields["endpoint-url"]
        for _ in 0..<6 where !endpoint.isHittable { app.swipeUp() }
        XCTAssertTrue(endpoint.exists); endpoint.tap(); endpoint.typeText("https://api.example.com/ingest")
        app.buttons["save-task"].tap()
        XCTAssertTrue(app.buttons["task-通用配置验收"].waitForExistence(timeout: 5))
        app.terminate()
        app.launchArguments = ["--ui-testing"]
        app.launch()
        XCTAssertTrue(app.buttons["task-通用配置验收"].waitForExistence(timeout: 10))
        capture(app, "自动化列表")
        app.buttons["task-通用配置验收"].tap()
        XCTAssertEqual(app.textFields["task-name"].value as? String, "通用配置验收")
        capture(app, "配置详情")
    }

    @MainActor
    func testHTTPSFailureRetryAndNoRepeatedUpload() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--reset-configurations", "--synthetic-health"]
        app.launchEnvironment = ["HEALTHRELAY_ACCEPTANCE_ENDPOINT": "https://localhost:18443/fail-once", "HEALTHRELAY_ACCEPTANCE_KEY": "synthetic-local-acceptance-key"]
        app.launch()
        let run = app.buttons["run-task-合成数据链路验收"]
        XCTAssertTrue(run.waitForExistence(timeout: 10)); run.tap()
        app.buttons["execute-task"].tap()
        let failed = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "HTTP 503")).firstMatch
        XCTAssertTrue(failed.waitForExistence(timeout: 15))
        capture(app, "首次请求失败保留批次")
        app.terminate()
        app.launchArguments = ["--ui-testing", "--synthetic-health"]
        app.launch()
        app.buttons["run-task-合成数据链路验收"].tap()
        app.buttons["execute-task"].tap()
        let success = app.staticTexts["execution-result"]
        let uploaded = NSPredicate(format: "label CONTAINS %@", "已上传并确认 1 条")
        expectation(for: uploaded, evaluatedWith: success)
        waitForExpectations(timeout: 15)
        capture(app, "重启后原批次确认成功")
        app.buttons["execute-task"].tap()
        let noData = NSPredicate(format: "label CONTAINS %@", "没有可读取的新记录")
        expectation(for: noData, evaluatedWith: success)
        waitForExpectations(timeout: 15)
        capture(app, "游标推进后不重复发送")
    }

    @MainActor
    func testAggregateTaskAndIndependentBackfill() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--reset-configurations", "--synthetic-health", "--synthetic-aggregate"]
        app.launchEnvironment = ["HEALTHRELAY_ACCEPTANCE_ENDPOINT": "https://localhost:18443/ingest", "HEALTHRELAY_ACCEPTANCE_KEY": "synthetic-local-acceptance-key"]
        app.launch()
        let run = app.buttons["run-task-合成数据链路验收"]
        XCTAssertTrue(run.waitForExistence(timeout: 10)); run.tap()
        app.buttons["execute-task"].tap()
        let result = app.staticTexts["execution-result"]
        expectation(for: NSPredicate(format: "label CONTAINS %@", "已上传并确认 2 条"), evaluatedWith: result)
        waitForExpectations(timeout: 15)
        let backfill = app.buttons["backfill-start"]
        for _ in 0..<3 where !backfill.isHittable { app.swipeUp() }
        backfill.tap()
        XCTAssertTrue(app.buttons["backfill-confirm"].waitForExistence(timeout: 5)); app.buttons["backfill-confirm"].tap()
        XCTAssertTrue(app.staticTexts["已完成"].waitForExistence(timeout: 15))
        capture(app, "独立历史补传完成")
        for _ in 0..<3 where !app.buttons["execute-task"].isHittable { app.swipeDown() }
        app.buttons["execute-task"].tap()
        expectation(for: NSPredicate(format: "label CONTAINS %@", "没有可读取的新记录"), evaluatedWith: result)
        waitForExpectations(timeout: 15)
        capture(app, "补传未重置日常进度")
    }

    @MainActor private func capture(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
