import SwiftUI
import WatchKit
import HealthRelayCore

@main struct HealthRelayWatchApp: App {
    @WKApplicationDelegateAdaptor(WatchAppDelegate.self) private var delegate
    @State private var store = WatchStore.shared
    @Environment(\.scenePhase) private var phase
    var body: some Scene {
        WindowGroup {
            NavigationStack {
                List {
                    Section {
                        Text("\(store.tasks.count) 个任务").font(.headline)
                        Text(store.loadError ?? (store.waitingForProtectedData ? "设备锁定，本地配置暂不可读，恢复访问后继续" : store.status)).font(.footnote)
                    }
                    ForEach(store.tasks) { task in
                        NavigationLink { WatchTaskView(store: store, id: task.id) } label: {
                            VStack(alignment: .leading) {
                                Text(task.name)
                                Text(task.enabled ? "已启用" : "未启用").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                    if store.tasks.isEmpty { Text("在 iPhone 编辑任务，选择 Apple Watch 后点击同步 Watch 配置。").font(.footnote) }
                }.navigationTitle("HealthRelay")
            }.task { await store.start() }
                .onChange(of: phase) { _, value in if value == .active { Task { await store.start() } } }
        }
    }
}

private struct WatchTaskView: View {
    @Bindable var store: WatchStore
    let id: UUID
    @State private var error: String?
    @State private var confirmingCancel = false
    @State private var values: [String: String] = [:]
    private var task: AutomationConfig? { store.tasks.first { $0.id == id } }
    var body: some View {
        List {
            if let task {
                let startIssues = store.executionStartIssues(task)
                Section {
                    Text(task.name).font(.headline)
                    Text("\(task.data.selections.count) 个指标 · \(URL(string: task.destination.url)?.host ?? "无效接口")").font(.footnote)
                    Text("接口须为最终 HTTPS 地址，无重定向。后台系统可能跟随重定向；检测到后不会确认批次。").font(.caption)
                }
                if !store.requiredHeaders(task).isEmpty {
                    Section("Watch 本机认证") {
                        ForEach(store.requiredHeaders(task), id: \.self) { name in
                            SecureField(name, text: Binding(get: { values[name] ?? "" }, set: { values[name] = $0 }))
                        }
                        Button("保存本机认证") { Task {
                            do { try await store.saveCredentials(id, values: values); values = [:] }
                            catch { self.error = error.localizedDescription }
                        } }
                        Text("已保存值留空可保留；值仅存于 Watch Keychain。").font(.caption)
                    }
                }
                Button(task.enabled ? "停用" : "授权并启用") { Task {
                    do { try await store.setEnabled(id, enabled: !task.enabled) } catch { self.error = error.localizedDescription }
                } }.disabled(store.active.contains(id))
                Button("运行一次") { Task { await store.run(id) } }.disabled(!startIssues.isEmpty || store.active.contains(id))
                if !startIssues.isEmpty { ForEach(startIssues, id: \.self) { Text($0).font(.footnote) } }
                if (try? store.journal.load(id).pending) != nil {
                    Button("取消未确认批次", role: .destructive) { confirmingCancel = true }.disabled(store.active.contains(id))
                        .confirmationDialog("取消传输并保留已确认位置？下次会重新读取未确认数据。", isPresented: $confirmingCancel) {
                            Button("取消批次", role: .destructive) { Task {
                                do { try await store.cancelPending(id) } catch { self.error = error.localizedDescription }
                            } }
                        }
                }
                if let log = store.outcomes[id] {
                    Section("最近结果") { Text(log.message).font(.footnote); Text(log.date, style: .relative).font(.caption) }
                }
                Text("后台时机由 watchOS 决定。排队表示等待传输，确认后才推进同步位置。").font(.caption)
            }
            if let error { Text(error).foregroundStyle(.red).font(.footnote) }
        }.navigationTitle("任务")
    }
}

@MainActor final class WatchAppDelegate: NSObject, WKApplicationDelegate {
    var store = WatchStore.shared
    func applicationDidFinishLaunching() { store.startBackgroundServices() }
    func handle(_ backgroundTasks: Set<WKRefreshBackgroundTask>) {
        for task in backgroundTasks {
            let completion = BackgroundTaskCompletion(task)
            if let upload = task as? WKURLSessionRefreshBackgroundTask, upload.sessionIdentifier == BackgroundUploader.identifier {
                task.expirationHandler = { Task { @MainActor in completion.finish() } }
                store.uploader.handleEvents { completion.finish() }
            } else if task is WKApplicationRefreshBackgroundTask {
                let work = Task { await store.runDue(trigger: "background"); completion.finish() }
                task.expirationHandler = { work.cancel(); Task { @MainActor in self.store.scheduleRecovery(); completion.finish() } }
            } else if task is WKWatchConnectivityRefreshBackgroundTask {
                store.handleConnectivity { completion.finish() }
                task.expirationHandler = { Task { @MainActor in completion.finish() } }
            } else { completion.finish() }
        }
    }
}

@MainActor private final class BackgroundTaskCompletion {
    private var task: WKRefreshBackgroundTask?
    init(_ task: WKRefreshBackgroundTask) { self.task = task }
    func finish() { task?.setTaskCompletedWithSnapshot(false); task = nil }
}
