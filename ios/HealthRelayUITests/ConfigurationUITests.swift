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
        // Small drags cannot flick past the HTTP section when optional rows change height.
        for _ in 0..<16 where !endpoint.isHittable {
            let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.60))
            let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35))
            start.press(forDuration: 0.1, thenDragTo: end)
        }
        capture(app, "接口配置定位")
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

    @MainActor
    func testForegroundIntervalRunsAgainWithoutNavigationOrManualRun() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--reset-configurations", "--synthetic-health", "--synthetic-periodic"]
        app.launchEnvironment = ["HEALTHRELAY_ACCEPTANCE_ENDPOINT": "https://localhost:18443/ingest", "HEALTHRELAY_ACCEPTANCE_KEY": "synthetic-local-acceptance-key"]
        app.launch()
        let run = app.buttons["run-task-合成数据链路验收"]
        XCTAssertTrue(run.waitForExistence(timeout: 10)); run.tap()
        let result = app.staticTexts["execution-result"]
        expectation(for: NSPredicate(format: "label CONTAINS %@", "已上传并确认 1 条"), evaluatedWith: result)
        waitForExpectations(timeout: 15)
        // Leave this page open. A scene-change-only scheduler never reaches this outcome.
        expectation(for: NSPredicate(format: "label CONTAINS %@", "没有可读取的新记录"), evaluatedWith: result)
        waitForExpectations(timeout: 75)
        capture(app, "保持前台到期自动检查")
    }

    @MainActor
    func testReminderPreferencesPersistWithoutEnablingAutomation() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--reset-configurations"]
        app.launch()
        XCTAssertTrue(app.buttons["new-task"].waitForExistence(timeout: 10))
        app.buttons["new-task"].tap()
        let name = app.textFields["task-name"]
        name.tap()
        if let value = name.value as? String { name.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: value.count)) }
        name.typeText("提醒配置验收")
        app.buttons["metric-picker"].tap()
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 5)); search.tap(); search.typeText("BodyMass")
        app.buttons["metric-HKQuantityTypeIdentifierBodyMass"].tap()
        app.buttons["metrics-done"].tap()
        let endpoint = app.textFields["endpoint-url"]
        for _ in 0..<16 where !endpoint.isHittable {
            let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.60))
            let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35))
            start.press(forDuration: 0.1, thenDragTo: end)
        }
        capture(app, "提醒任务接口定位")
        XCTAssertTrue(endpoint.isHittable)
        endpoint.tap(); endpoint.typeText("https://api.example.com/ingest")
        let reminders = app.buttons["reminder-settings"]
        for _ in 0..<10 where !reminders.isHittable { app.swipeUp() }
        XCTAssertTrue(reminders.isHittable); reminders.tap()
        let enabled = app.switches["reminder-enabled"]
        XCTAssertTrue(enabled.waitForExistence(timeout: 5))
        enabled.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
        XCTAssertTrue(app.staticTexts["保存后下次提醒"].waitForExistence(timeout: 3))
        app.navigationBars["安排提醒"].buttons.element(boundBy: 0).tap()
        app.buttons["save-task"].tap()
        XCTAssertTrue(app.navigationBars["新建自动化"].waitForNonExistence(timeout: 5))
        XCTAssertFalse(app.alerts["保存失败"].exists)
        let edit = app.buttons["task-提醒配置验收"]
        XCTAssertTrue(edit.waitForExistence(timeout: 5))
        app.terminate(); app.launchArguments = ["--ui-testing"]; app.launch()
        XCTAssertTrue(edit.waitForExistence(timeout: 10)); edit.tap()
        XCTAssertTrue(app.staticTexts["已关闭"].exists)
        for _ in 0..<10 where !reminders.isHittable { app.swipeUp() }
        reminders.tap()
        XCTAssertTrue(enabled.waitForExistence(timeout: 5)); XCTAssertEqual(enabled.value as? String, "1")
        capture(app, "提醒配置持久化")
    }

    @MainActor
    func testHEAVersionAndDataFamilyPersist() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--reset-configurations"]
        app.launch()
        XCTAssertTrue(app.buttons["new-task"].waitForExistence(timeout: 10))
        app.buttons["new-task"].tap()
        let name = app.textFields["task-name"]
        name.tap()
        if let value = name.value as? String { name.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: value.count)) }
        name.typeText("HEA周期配置验收")
        app.buttons["metric-picker"].tap()
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap(); search.typeText("SexualActivity")
        let metric = app.buttons["metric-HKCategoryTypeIdentifierSexualActivity"]
        XCTAssertTrue(metric.waitForExistence(timeout: 5)); metric.tap()
        app.buttons["metrics-done"].tap()

        let format = app.buttons["export-format"]
        reveal(format, in: app)
        XCTAssertTrue(format.isHittable); format.tap()
        app.buttons["HEA JSON · v1"].tap()
        let family = app.buttons["hea-data-type"]
        reveal(family, in: app)
        XCTAssertTrue(family.isHittable); family.tap()
        app.buttons["周期记录"].tap()
        let endpoint = app.textFields["endpoint-url"]
        reveal(endpoint, in: app)
        XCTAssertTrue(endpoint.isHittable); endpoint.tap(); endpoint.typeText("https://api.example.com/ingest")
        app.buttons["save-task"].tap()
        let edit = app.buttons["task-HEA周期配置验收"]
        XCTAssertTrue(edit.waitForExistence(timeout: 5))
        app.terminate(); app.launchArguments = ["--ui-testing"]; app.launch()
        XCTAssertTrue(edit.waitForExistence(timeout: 10)); edit.tap()
        reveal(format, in: app)
        XCTAssertTrue(format.label.contains("HEA JSON · v1") || (format.value as? String) == "HEA JSON · v1")
        reveal(family, in: app)
        XCTAssertTrue(family.label.contains("周期记录") || (family.value as? String) == "周期记录")
        capture(app, "HEA版本与数据族重启恢复")
    }


    @MainActor
    func testPasteConfigurationImportsDisabledAndPersists() throws {
        let app = launchConfigurationImport()
        let input = app.textViews["configuration-json"]
        XCTAssertTrue(input.waitForExistence(timeout: 5)); input.tap()
        input.typeText(configurationJSON())
        app.buttons["check-configuration"].tap()
        XCTAssertTrue(app.staticTexts["configuration-valid"].waitForExistence(timeout: 5))
        let preview = app.staticTexts["preview-task-0"]
        reveal(preview, in: app)
        XCTAssertTrue(preview.label.contains("JSON 导入验收"))
        XCTAssertTrue(preview.label.contains("Authorization"))
        capture(app, "JSON检查与配置预览")
        let importButton = app.buttons["import-new-configurations"]
        reveal(importButton, in: app); XCTAssertTrue(importButton.isEnabled); importButton.tap()
        let row = app.buttons["task-JSON 导入验收"]
        XCTAssertTrue(row.waitForExistence(timeout: 5)); XCTAssertTrue(row.label.contains("已关闭"))
        app.terminate(); app.launchArguments = ["--ui-testing"]; app.launch()
        XCTAssertTrue(row.waitForExistence(timeout: 10)); XCTAssertTrue(row.label.contains("已关闭"))
        XCTAssertTrue(row.label.contains("iPhone"))
        capture(app, "JSON导入重启后保持关闭")
        row.press(forDuration: 1)
        app.buttons["复制为 Apple Watch"].tap()
        XCTAssertTrue(app.textFields["task-name"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.textFields["task-name"].value as? String, "JSON 导入验收 · Watch")
        XCTAssertTrue(app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Apple Watch")).firstMatch.exists)
        app.buttons["save-task"].tap()
        let copy = app.buttons["task-JSON 导入验收 · Watch"]
        XCTAssertTrue(copy.waitForExistence(timeout: 5)); XCTAssertTrue(copy.label.contains("已关闭"))
        XCTAssertTrue(copy.label.contains("Apple Watch")); XCTAssertTrue(row.exists)
        capture(app, "独立Watch副本默认关闭")
    }

    @MainActor
    func testInvalidNestedFieldShowsPathAndCannotSave() throws {
        let app = launchConfigurationImport()
        let input = app.textViews["configuration-json"]
        XCTAssertTrue(input.waitForExistence(timeout: 5)); input.tap()
        input.typeText(configurationJSON(unknownField: true))
        app.buttons["check-configuration"].tap()
        let issue = app.staticTexts["configuration-issue-0"]
        reveal(issue, in: app)
        XCTAssertTrue(issue.waitForExistence(timeout: 5))
        XCTAssertTrue(issue.label.contains("/execution/unknownOption"))
        XCTAssertFalse(app.buttons["import-new-configurations"].exists)
        capture(app, "未知嵌套字段显示路径并阻止保存")
        app.buttons["cancel-configuration-import"].tap()
        XCTAssertFalse(app.buttons["task-JSON 导入验收"].exists)
        app.terminate(); app.launchArguments = ["--ui-testing"]; app.launch()
        XCTAssertTrue(app.buttons["new-task"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["task-JSON 导入验收"].exists)
    }


    @MainActor
    func testChangingCheckedJSONRequiresAnotherCheck() throws {
        let app = launchConfigurationImport()
        let input = app.textViews["configuration-json"]
        XCTAssertTrue(input.waitForExistence(timeout: 5)); input.tap()
        input.typeText(configurationJSON())
        app.buttons["check-configuration"].tap()
        XCTAssertTrue(app.staticTexts["configuration-valid"].waitForExistence(timeout: 5))
        for _ in 0..<6 where !input.isHittable { app.swipeDown() }
        let checkedJSON = input.value as? String
        input.tap(); input.typeText(" ")
        XCTAssertNotEqual(input.value as? String, checkedJSON)
        XCTAssertFalse(app.buttons["import-new-configurations"].exists)
        XCTAssertFalse(app.staticTexts["configuration-valid"].exists)
        app.buttons["check-configuration"].tap()
        // Tapping the editor can insert inside a field; either new verdict is valid evidence of rechecking.
        let newReport = app.staticTexts.matching(NSPredicate(format: "identifier IN %@", ["configuration-valid", "configuration-invalid"])).firstMatch
        XCTAssertTrue(newReport.waitForExistence(timeout: 5))
        if app.staticTexts["configuration-invalid"].exists {
            XCTAssertFalse(app.buttons["import-new-configurations"].exists)
        }
        capture(app, "编辑JSON后重新检查")
    }


    @MainActor
    func testInvalidSingleTaskCanOpenEditorForRepair() throws {
        let app = launchConfigurationImport()
        let input = app.textViews["configuration-json"]
        XCTAssertTrue(input.waitForExistence(timeout: 5)); input.tap()
        input.typeText(configurationJSON().replacingOccurrences(of: "https://api.example.com/ingest", with: "invalid"))
        app.buttons["check-configuration"].tap()
        XCTAssertTrue(app.staticTexts["configuration-invalid"].waitForExistence(timeout: 5))
        let edit = app.buttons["edit-imported-configuration"]
        reveal(edit, in: app); edit.tap()
        XCTAssertTrue(app.textFields["task-name"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.textFields["task-name"].value as? String, "JSON 导入验收")
        XCTAssertFalse(app.buttons["save-task"].isEnabled)
        capture(app, "语义错误配置进入编辑页修复")
    }

    @MainActor private func launchConfigurationImport() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--reset-configurations"]
        app.launch()
        XCTAssertTrue(app.buttons["new-task"].waitForExistence(timeout: 10))
        let entry = app.buttons["paste-configuration"]
        reveal(entry, in: app)
        XCTAssertTrue(entry.exists, "The automation list must offer a paste JSON entry")
        entry.tap()
        return app
    }

    private func configurationJSON(unknownField: Bool = false) -> String {
        """
        {"schemaVersion":1,"device":"iPhone","id":"11111111-1111-4111-8111-111111111111","revision":9,"name":"JSON 导入验收","enabled":true,"data":{"family":"quantity","selections":[{"typeIdentifier":"HKQuantityTypeIdentifierStepCount","unit":"count","sources":[]}],"excludedSources":[]},"range":{"mode":"today"},"export":{"format":"healthrelay.v1","mode":"raw","grouping":"none","statistics":[],"timeZone":"Asia/Shanghai"},"destination":{"kind":"http","url":"https://api.example.com/ingest","method":"POST","headers":{},"credentialHeader":"Authorization","timeoutSeconds":30,"acknowledgement":"http2xx"},"execution":{"onDataChange":false,"onForeground":false,"minimumIntervalSeconds":1800,"batchMaxRecords":500,"batchMaxBytes":1048576\(unknownField ? ",\"unknownOption\":true" : "")}}
        """
    }

    @MainActor private func reveal(_ element: XCUIElement, in app: XCUIApplication) {
        for _ in 0..<20 where !element.isHittable {
            let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.60))
            let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35))
            start.press(forDuration: 0.1, thenDragTo: end)
        }
    }

    @MainActor private func capture(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
