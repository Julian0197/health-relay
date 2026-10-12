import SwiftUI
import HealthRelayCore

struct TaskExecutionView: View {
    @Bindable var store: AutomationStore
    let taskID: UUID
    @Environment(\.dismiss) private var dismiss
    @State private var readSummary: String?
    @State private var checking = false
    @State private var cancellingPending = false
    @State private var error: String?
    private var task: AutomationConfig? { store.tasks.first { $0.id == taskID } }
    var body: some View {
        List {
            if let task {
                Section {
                    Toggle("启用自动化", isOn: Binding(get: { self.task?.enabled ?? false }, set: { enabled in
                        Task { do { try await store.setEnabled(task, enabled: enabled) } catch { self.error = error.localizedDescription } }
                    })).disabled(store.active.contains(task.id))
                    Button("立即运行", systemImage: "play.fill") { Task { await store.run(task) } }
                        .accessibilityIdentifier("execute-task").disabled(store.active.contains(task.id) || !task.executionIssues.isEmpty)
                    Button("检查健康读取", systemImage: "heart.text.clipboard") {
                        checking = true
                        Task {
                            defer { checking = false }
                            do { readSummary = try await store.checkRead(task) }
                            catch { self.error = "健康数据暂不可读，请解锁并检查读取权限" }
                        }
                    }.disabled(checking || store.active.contains(task.id))
                    if checking { ProgressView("正在检查读取") }
                    if store.active.contains(task.id) { ProgressView("正在读取并上传") }
                } footer: { Text("手动运行也会读取健康数据并向配置接口上传。没有新记录时不会发送请求。iOS 决定后台唤醒时机。") }
                if let readSummary { Section("读取检查") { Text(readSummary) } }
                if !task.executionIssues.isEmpty {
                    Section("执行前需要调整") { ForEach(task.executionIssues, id: \.self) { Text($0).font(.footnote) } }
                }
                if let outcome = store.outcomes[task.id] {
                    Section("当前结果") {
                        Text(outcome.message).accessibilityIdentifier("execution-result")
                        if let code = outcome.httpStatus { LabeledContent("HTTP", value: String(code)) }
                        Text(outcome.date.formatted()).font(.caption).foregroundStyle(.secondary)
                    }
                }
                if let state = try? store.journal.load(task.id) {
                    if let pending = state.pending {
                        Section("待上传") {
                            Button("取消待上传批次", role: .destructive) { cancellingPending = true }
                                .disabled(store.active.contains(task.id))
                            LabeledContent("记录", value: "\(pending.recordCount) 条")
                            LabeledContent("已尝试", value: "\(pending.attempts) 次")
                            Text(pending.automaticRetry ? "网络恢复后继续重试，或点立即运行。" : "请检查接口或认证后点立即运行；批次保留，不自动反复请求。")
                                .font(.footnote)
                        }
                    }
                    Section("运行日志") {
                        ForEach(state.logs) { log in
                            VStack(alignment: .leading, spacing: 6) {
                                Text(log.message)
                                Text(log.date.formatted()).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        if state.logs.isEmpty { Text("尚未运行").foregroundStyle(.secondary) }
                    }
                }
            }
        }.navigationTitle(task?.name ?? "运行与日志")
            .toolbar { Button("完成") { dismiss() } }
            .confirmationDialog("取消这个待上传批次？不会推进游标；修改配置后，下次运行会重新读取未确认的数据。", isPresented: $cancellingPending, titleVisibility: .visible) {
                Button("取消批次并保留同步位置", role: .destructive) {
                    guard let task else { return }
                    do { try store.cancelPending(task) } catch { self.error = error.localizedDescription }
                }
            }
            .alert("无法执行", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("知道了") { error = nil }
            } message: { Text(error ?? "") }
    }
}

#if DEBUG && targetEnvironment(simulator)
/// Synthetic records are available only to an explicit simulator acceptance run.
/// This reader is absent from physical-device and Release builds.
@MainActor final class SyntheticHealthReader: HealthDataReader {
    func read(task: AutomationConfig, selection: MetricSelection, checkpoint: TypeCheckpoint, limit: Int) async throws -> ReadPage {
        guard checkpoint.anchor == nil else { return ReadPage(records: [], anchor: checkpoint.anchor, hasMore: false) }
        let records = [HealthRecord(op: .upsert, typeIdentifier: selection.id, recordId: "synthetic-quantity-001", start: "2026-10-12T00:00:00Z", end: "2026-10-12T00:00:00Z", source: RecordSource(id: "test.synthetic", name: "Synthetic acceptance"), payload: ["value": .number(70), "unit": .string(selection.unit ?? "count")])]
        return ReadPage(records: records, anchor: Data("synthetic-cursor-1".utf8), hasMore: false)
    }
}
#endif
