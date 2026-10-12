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

    @MainActor private func capture(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
