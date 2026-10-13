import Foundation
import XCTest
@testable import HealthRelayCore

final class ReminderTests: XCTestCase {
    var calendar: Calendar {
        var value = Calendar(identifier: .gregorian); value.timeZone = TimeZone(identifier: "Asia/Shanghai")!; return value
    }
    func testHourlyAndDailyReminderDates() {
        let now = AutomationConfig.parseDate("2026-10-13T03:20:00Z")!
        var reminder = ReminderSettings(); reminder.enabled = true; reminder.frequency = .hourly; reminder.minute = 30
        XCTAssertEqual(reminder.nextDate(after: now, calendar: calendar), AutomationConfig.parseDate("2026-10-13T03:30:00Z"))
        reminder.frequency = .daily; reminder.hour = 10
        XCTAssertEqual(reminder.nextDate(after: now, calendar: calendar), AutomationConfig.parseDate("2026-10-14T02:30:00Z"))
    }
    func testSelectedDaysAndDisabledReminders() {
        let now = AutomationConfig.parseDate("2026-10-13T03:20:00Z")! // Tuesday
        var reminder = ReminderSettings(); reminder.enabled = true; reminder.frequency = .selectedDays
        reminder.weekdays = [2, 4, 4]; reminder.hour = 9; reminder.minute = 0
        XCTAssertEqual(reminder.calendarComponents.count, 2)
        XCTAssertEqual(reminder.nextDate(after: now, calendar: calendar), AutomationConfig.parseDate("2026-10-14T01:00:00Z"))
        reminder.enabled = false
        XCTAssertNil(reminder.nextDate(after: now, calendar: calendar)); XCTAssertTrue(reminder.calendarComponents.isEmpty)
    }
    func testReminderValidationAndBackwardCompatibleConfiguration() throws {
        var reminder = ReminderSettings(); reminder.enabled = true; reminder.frequency = .selectedDays; reminder.weekdays = []
        XCTAssertFalse(reminder.validationIssues.isEmpty)
        reminder.weekdays = [2]; reminder.minute = 60
        XCTAssertFalse(reminder.validationIssues.isEmpty)
        let task = AutomationConfig.newTask()
        let json = try JSONEncoder().encode(task)
        XCTAssertNil(try JSONDecoder().decode(AutomationConfig.self, from: json).execution.reminder)
    }
    func testDSTReminderRemainsInLocalTime() {
        var cal = calendar; cal.timeZone = TimeZone(identifier: "America/New_York")!
        var reminder = ReminderSettings(); reminder.enabled = true; reminder.hour = 9; reminder.minute = 0
        let before = AutomationConfig.parseDate("2026-03-07T15:00:00Z")!
        XCTAssertEqual(reminder.nextDate(after: before, calendar: cal), AutomationConfig.parseDate("2026-03-08T13:00:00Z"))
    }
}
