import SwiftUI
import UserNotifications
import HealthRelayCore

struct ReminderEditorView: View {
    @Binding var settings: ReminderSettings?
    @Environment(\.scenePhase) private var phase
    @Environment(\.openURL) private var openURL
    @State private var permission = "正在读取"
    @State private var error: String?
    private var reminder: Binding<ReminderSettings> {
        Binding(get: { settings ?? ReminderSettings() }, set: { settings = $0 })
    }
    private var time: Binding<Date> {
        Binding(get: {
            Calendar.current.date(from: DateComponents(year: 2026, month: 1, day: 1,
                hour: reminder.wrappedValue.hour, minute: reminder.wrappedValue.minute)) ?? Date()
        }, set: { date in
            reminder.wrappedValue.hour = Calendar.current.component(.hour, from: date)
            reminder.wrappedValue.minute = Calendar.current.component(.minute, from: date)
        })
    }
    var body: some View {
        Form {
            Section {
                Toggle("启用提醒", isOn: reminder.enabled).accessibilityIdentifier("reminder-enabled")
                if reminder.wrappedValue.enabled {
                    Picker("提醒频率", selection: reminder.frequency) {
                        ForEach(ReminderSettings.Frequency.allCases, id: \.self) { Text($0.title).tag($0) }
                    }
                    if reminder.wrappedValue.frequency == .hourly {
                        Picker("每小时第几分钟", selection: reminder.minute) {
                            ForEach(0..<60) { Text("\($0) 分").tag($0) }
                        }
                    } else {
                        DatePicker("提醒时间", selection: time, displayedComponents: .hourAndMinute)
                    }
                    if reminder.wrappedValue.frequency == .selectedDays {
                        ForEach([2, 3, 4, 5, 6, 7, 1], id: \.self) { day in
                            Toggle(Calendar.current.weekdaySymbols[day - 1], isOn: Binding(get: {
                                reminder.wrappedValue.weekdays.contains(day)
                            }, set: { enabled in
                                reminder.wrappedValue.weekdays.removeAll { $0 == day }
                                if enabled { reminder.wrappedValue.weekdays.append(day) }
                            }))
                        }
                    }
                    if let next = reminder.wrappedValue.nextDate(after: Date()) {
                        LabeledContent("保存后下次提醒", value: next.formatted(date: .abbreviated, time: .shortened))
                    }
                    ForEach(reminder.wrappedValue.validationIssues, id: \.self) { Text($0).foregroundStyle(.red) }
                }
            } footer: {
                Text("返回任务页保存后生效，并需启用自动化。按手机当地时间提醒；后台同步成功后，提醒仍可能出现。")
            }
            Section("通知权限") {
                LabeledContent("当前状态", value: permission)
                Button("允许通知") {
                    Task {
                        do { _ = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) }
                        catch { self.error = "无法请求通知权限，请在系统设置中检查。" }
                        await refreshPermission()
                    }
                }
                Button("打开通知设置") { if let url = URL(string: UIApplication.openNotificationSettingsURLString) { openURL(url) } }
                if let error { Text(error).foregroundStyle(.red) }
            }
            Section {
                Text("提醒本身不会执行任务。点通知可查看任务；长按通知选择“打开并同步”，会在打开 App 后立即运行。任务已关闭、删除或正在运行时，只返回自动化列表。")
            }
        }.navigationTitle("安排提醒")
            .task { await refreshPermission() }
            .onChange(of: phase) { _, new in if new == .active { Task { await refreshPermission() } } }
    }
    private func refreshPermission() async {
        switch await UNUserNotificationCenter.current().notificationSettings().authorizationStatus {
        case .authorized, .provisional, .ephemeral: permission = "已允许"
        case .denied: permission = "未允许，请打开通知设置"
        case .notDetermined: permission = "尚未请求"
        @unknown default: permission = "未知"
        }
    }
}
