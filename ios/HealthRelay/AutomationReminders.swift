import Foundation
import UserNotifications
import HealthRelayCore

/// Reminders only notify. Health data is read after an explicit Open & Sync action.
@MainActor final class AutomationReminders: NSObject, UNUserNotificationCenterDelegate {
    private static let prefix = "healthrelay.reminder."
    private static let category = "healthrelay.reminder"
    private static let syncAction = "healthrelay.reminder.sync"
    private let center = UNUserNotificationCenter.current()

    override init() {
        super.init()
        center.delegate = self
        let sync = UNNotificationAction(identifier: Self.syncAction, title: "打开并同步", options: [.foreground])
        center.setNotificationCategories([UNNotificationCategory(identifier: Self.category, actions: [sync], intentIdentifiers: [])])
    }

    func replace(tasks: [AutomationConfig]) async throws {
        let existing = await center.pendingNotificationRequests().filter { $0.identifier.hasPrefix(Self.prefix) }
        center.removePendingNotificationRequests(withIdentifiers: existing.map(\.identifier))
        for task in tasks where task.enabled {
            for (index, components) in (task.execution.reminder?.calendarComponents ?? []).enumerated() {
                let content = UNMutableNotificationContent()
                content.title = "HealthRelay · \(task.name)"
                content.body = "解锁并打开 App 检查同步。此提醒不代表任务已执行。"
                content.sound = .default; content.categoryIdentifier = Self.category
                content.userInfo = ["taskID": task.id.uuidString]
                let trigger = UNCalendarNotificationTrigger(dateMatching: components, repeats: true)
                try await center.add(UNNotificationRequest(identifier: Self.prefix + task.id.uuidString + ".\(index)", content: content, trigger: trigger))
            }
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
        willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse) async {
        guard let rawID = response.notification.request.content.userInfo["taskID"] as? String,
              let id = UUID(uuidString: rawID) else { return }
        let shouldRun = response.actionIdentifier == "healthrelay.reminder.sync"
        await AutomationStore.shared.openReminder(id, run: shouldRun)
    }
}
