import Foundation

public struct ReminderSettings: Codable, Equatable, Sendable {
    public enum Frequency: String, Codable, CaseIterable, Sendable {
        case hourly, daily, selectedDays
        public var title: String {
            switch self { case .hourly: "每小时"; case .daily: "每天"; case .selectedDays: "指定星期" }
        }
    }
    public var enabled = false
    public var frequency: Frequency = .daily
    public var hour = 9
    public var minute = 0
    /// Calendar weekday numbers: Sunday = 1 ... Saturday = 7.
    public var weekdays = [2, 3, 4, 5, 6]
    public init() {}

    public var validationIssues: [String] {
        guard enabled else { return [] }
        var issues: [String] = []
        if !(0...23).contains(hour) || !(0...59).contains(minute) { issues.append("提醒时间无效") }
        if frequency == .selectedDays && (weekdays.isEmpty || !weekdays.allSatisfy { (1...7).contains($0) }) {
            issues.append("请至少选择一个有效的提醒星期")
        }
        return issues
    }
    public var calendarComponents: [DateComponents] {
        guard enabled, validationIssues.isEmpty else { return [] }
        switch frequency {
        case .hourly: return [DateComponents(minute: minute)]
        case .daily: return [DateComponents(hour: hour, minute: minute)]
        case .selectedDays:
            return Set(weekdays).sorted().map { DateComponents(hour: hour, minute: minute, weekday: $0) }
        }
    }
    public func nextDate(after date: Date, calendar: Calendar = .autoupdatingCurrent) -> Date? {
        calendarComponents.compactMap {
            calendar.nextDate(after: date, matching: $0, matchingPolicy: .nextTime, repeatedTimePolicy: .first)
        }.min()
    }
}
