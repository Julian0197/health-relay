import SwiftUI
import HealthRelayCore

struct TaskExecutionView: View {
    @Bindable var store: AutomationStore
    let taskID: UUID
    @Environment(\.dismiss) private var dismiss
    @State private var readSummary: String?
    @State private var checking = false
    @State private var cancellingPending = false
    @State private var showingBackfill = false
    @State private var backfillStart = Date().addingTimeInterval(-86400)
    @State private var backfillEnd = Date()
    @State private var removingJob: BackfillJob?
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
                Section("历史补传") {
                    Button("选择时间补传", systemImage: "clock.arrow.circlepath") { backfillEnd = Date(); showingBackfill = true }
                        .accessibilityIdentifier("backfill-start").disabled(store.active.contains(task.id) || store.backfills.contains { $0.task.id == task.id && $0.completedAt == nil })
                    ForEach(store.backfills.filter { $0.task.id == task.id }) { job in
                        VStack(alignment: .leading, spacing: 6) {
                            Text("\(job.task.range.start ?? "") → \(job.task.range.end ?? "")").font(.caption)
                            Text(job.completedAt == nil ? "待完成" : "已完成")
                            if let log = store.outcomes[job.id] ?? (try? store.journal.load(job.id).logs.first) { Text(log.message).font(.footnote) }
                            if store.active.contains(job.id) { ProgressView() }
                            HStack {
                                if job.completedAt == nil { Button("继续补传") { Task { await store.runBackfill(job) } } }
                                Button(job.completedAt == nil ? "取消补传" : "删除记录", role: .destructive) { removingJob = job }
                            }.buttonStyle(.borderless).disabled(store.active.contains(job.id))
                        }
                    }
                    Text("补传使用独立进度和固定日期，不会重置日常同步。大范围会分批继续；已上传的数据不会因取消而撤回。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
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
                        if let data = try? JSONEncoder().encode(state.logs), let text = String(data: data, encoding: .utf8) {
                            ShareLink("导出运行诊断", item: text)
                        }

                        ForEach(state.logs) { log in
                            VStack(alignment: .leading, spacing: 6) {
                                Text(log.message)
                                if let duration = log.durationSeconds { Text("\(log.trigger ?? "manual") · \(duration, specifier: "%.1f") 秒 · \(log.records) 条 / \(log.batches) 批").font(.caption) }
                                if let omitted = log.omittedDeletions, omitted > 0 { Text("跳过删除事件：\(omitted)").font(.caption) }
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
            .sheet(isPresented: $showingBackfill) {
                NavigationStack {
                    Form {
                        DatePicker("开始", selection: $backfillStart, in: ...Date())
                        DatePicker("结束", selection: $backfillEnd, in: ...Date())
                        Text("按原任务的指标、格式、单位和接口发送。汇总会读取与该范围相交的完整窗口。")
                    }.navigationTitle("历史补传")
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) { Button("取消") { showingBackfill = false } }
                        ToolbarItem(placement: .confirmationAction) {
                            Button("开始") {
                                guard let task else { return }; showingBackfill = false
                                Task { do { try await store.startBackfill(task, start: backfillStart, end: backfillEnd) } catch { self.error = error.localizedDescription } }
                            }.accessibilityIdentifier("backfill-confirm").disabled(backfillStart >= backfillEnd)
                        }
                    }
                }
            }
            .confirmationDialog("删除补传进度？已上传的数据会保留。", isPresented: Binding(get: { removingJob != nil }, set: { if !$0 { removingJob = nil } }), titleVisibility: .visible) {
                Button("删除补传进度", role: .destructive) {
                    guard let job = removingJob else { return }
                    do { try store.removeBackfill(job) } catch { self.error = error.localizedDescription }; removingJob = nil
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
        var payload: [String: JSONValue] = ["value": .number(70), "unit": .string(selection.unit ?? "count")]
        if task.export.mode == .aggregate {
            payload["aggregation"] = .bool(true)
            for statistic in task.statistics(for: selection) { payload[statistic.rawValue] = .number(70) }
        }
        let records = [HealthRecord(op: .upsert, typeIdentifier: selection.id, recordId: "synthetic-quantity-001", start: "2026-10-12T00:00:00Z", end: "2026-10-12T00:00:00Z", source: RecordSource(id: "test.synthetic", name: "Synthetic acceptance"), payload: payload)]
        return ReadPage(records: records, anchor: Data("synthetic-cursor-1".utf8), hasMore: false)
    }
}
#endif
