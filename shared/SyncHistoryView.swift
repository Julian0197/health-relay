import SwiftUI
import Combine
import HealthRelayCore

@MainActor struct SyncHistoryView: View {
    @State private var browser: SyncHistoryBrowser
    private let notice: @MainActor () -> String?
    @Environment(\.scenePhase) private var phase
    init(history: SyncHistoryStore, taskID: UUID? = nil, notice: @escaping @MainActor () -> String? = { nil }) {
        _browser = State(initialValue: SyncHistoryBrowser(store: history, taskID: taskID)); self.notice = notice
    }
    var body: some View {
        let grouped = Dictionary(grouping: browser.entries) { Calendar.current.startOfDay(for: $0.updatedAt) }
        List {
            Section {
                Picker("同步结果", selection: $browser.filter) {
                    Text("全部").tag(SyncHistoryFilter.all)
                    Text("成功").tag(SyncHistoryFilter.success)
                    Text("待处理与异常").tag(SyncHistoryFilter.attention)
                }
                #if os(iOS)
                .pickerStyle(.segmented)
                #endif
                .accessibilityIdentifier("history-filter")
                Text("最近 20 天 · 本机记录").font(.caption).foregroundStyle(.secondary)
                if let warning = notice() { Label(warning, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange) }
            }
            if let error = browser.error {
                Section {
                    Text(error).foregroundStyle(.orange)
                    Button("重试") { Task { await browser.reload() } }.accessibilityIdentifier("history-retry")
                }
            }
            if browser.entries.isEmpty && browser.error == nil && !browser.loading {
                Section {
                    Label("暂无同步历史", systemImage: "clock.arrow.circlepath").font(.headline)
                    Text("成功、失败和待确认的上传会记录在这里。没有新数据的检查不会占用列表。")
                        .font(.footnote).foregroundStyle(.secondary)
                }.accessibilityIdentifier("history-empty")
            }
            ForEach(grouped.keys.sorted(by: >), id: \.self) { day in
                Section(historyDay(day)) {
                    ForEach(grouped[day] ?? []) { entry in
                        NavigationLink {
                            SyncHistoryDetailView(history: browser.store, entryID: entry.id)
                        } label: { SyncHistoryRow(entry: entry) }
                        .accessibilityIdentifier("history-entry-\(entry.id)")
                    }
                }
            }
            if browser.loading { Section { ProgressView("正在读取历史…") } }
            else if browser.nextCursor != nil {
                Section { Button("加载更多") { Task { await browser.loadMore() } }.accessibilityIdentifier("history-load-more") }
            }
            Section {
                Text("同步时间是收到有效回执的时间；测量时间单独显示。历史仅保留最近 20 × 24 小时。时间按设备时区（\(TimeZone.current.identifier)）显示。")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .navigationTitle("同步历史")
        .toolbar {
            Button { Task { await browser.reload() } } label: { Image(systemName: "arrow.clockwise") }
                .accessibilityLabel("刷新同步历史").accessibilityIdentifier("history-refresh")
        }
        .task { await browser.reload() }
        .onChange(of: browser.filter) { _, _ in Task { await browser.reload() } }
        .onChange(of: phase) { _, value in if value == .active { Task { await browser.reload() } } }
        .onReceive(NotificationCenter.default.publisher(for: .syncHistoryChanged).receive(on: RunLoop.main)) { notification in
            if notification.userInfo?["path"] as? String == browser.store.file.path { Task { await browser.reload() } }
        }
        #if os(iOS)
        .refreshable { await browser.reload() }
        #endif
    }
}

private struct SyncHistoryRow: View {
    let entry: SyncHistoryEntry
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(entry.context.taskName).font(.headline)
            Label(entry.state.title, systemImage: historyIcon(entry.state)).foregroundStyle(historyColor(entry.state)).font(.subheadline)
            Text("\(entry.state == .succeeded && entry.confirmedAt == nil ? "记录时间" : historyTimeLabel(entry.state))：\((entry.confirmedAt ?? entry.updatedAt).formatted(.dateTime.hour().minute().second()))")
                .font(.caption)
            Text(entry.batchID == nil && !entry.legacy ? "未形成上传批次" : "发送 \(entry.summary.recordCount) 条 · \(historyKind(entry.context.kind))")
                .font(.caption).foregroundStyle(.secondary)
            ForEach(Array(entry.summary.metrics.prefix(2))) { metric in
                Text("\(metric.title)：\(historyMetricValue(metric))").font(.caption).foregroundStyle(.secondary)
            }
            if entry.legacy { Text("旧版执行摘要").font(.caption).foregroundStyle(.secondary) }
        }.padding(.vertical, 3)
    }
}

@MainActor struct SyncHistoryDetailView: View {
    let history: SyncHistoryStore
    let entryID: String
    @State private var detail: SyncHistoryDetail?
    @State private var error: String?
    @State private var loading = true
    var body: some View {
        List {
            if let detail {
                let entry = detail.entry
                Section("同步结果") {
                    Text(entry.context.taskName).font(.headline)
                    Label(entry.state.title, systemImage: historyIcon(entry.state)).foregroundStyle(historyColor(entry.state))
                    if let confirmed = entry.confirmedAt { historyDate("同步时间（回执确认）", confirmed) }
                    else if entry.state == .succeeded { Text("同步确认时间暂无（旧版回执未记录）").font(.footnote).foregroundStyle(.secondary) }
                    if let queued = entry.queuedAt { historyDate("排队时间", queued) }
                    if entry.confirmedAt == nil {
                        historyDate(entry.state == .succeeded ? "记录时间" : historyTimeLabel(entry.state), entry.updatedAt)
                    } else if let confirmed = entry.confirmedAt, entry.updatedAt > confirmed {
                        historyDate("最近活动时间", entry.updatedAt)
                    }
                    Text("尝试 \(entry.attempts) 次 · 发送 \(entry.summary.recordCount) 条，其中删除 \(entry.summary.deletions) 条").font(.footnote)
                    if let host = entry.context.destinationHost { Text("服务：\(host)").font(.footnote) }
                    if let code = entry.httpStatus { Text("HTTP \(code)").font(.footnote) }
                    if let message = entry.message { Text(message).font(.footnote) }
                    if entry.legacy { Text("旧版执行摘要：只保留当时存在的日志，未记录的指标数值或原始时间显示暂无。").font(.caption).foregroundStyle(.secondary) }
                }
                Section("数据测量范围") {
                    if let from = entry.summary.measuredFrom { historyDate("开始", from) }
                    if let to = entry.summary.measuredTo { historyDate("结束", to) }
                    if entry.summary.measuredFrom == nil && entry.summary.measuredTo == nil { Text("暂无测量时间").foregroundStyle(.secondary) }
                }
                ForEach(entry.summary.metrics) { metric in
                    Section(metric.title) {
                        Text("\(metric.records) 条记录 · 删除 \(metric.deletions) 条").font(.footnote)
                        if metric.latestValue != nil { Text("最新记录值：\(historyMetricValue(metric))") }
                        if let description = metric.detail { Text(description).font(.footnote).foregroundStyle(.secondary) }
                        if let from = metric.measuredFrom { historyDate("测量开始", from) }
                        if let to = metric.measuredTo { historyDate("测量结束", to) }
                    }
                }
                if entry.summary.metrics.isEmpty { Section("数据摘要") { Text("暂无指标明细").foregroundStyle(.secondary) } }
                Section("排队与尝试记录") {
                    ForEach(detail.events) { event in
                        VStack(alignment: .leading, spacing: 4) {
                            Label(event.state.title, systemImage: historyIcon(event.state)).foregroundStyle(historyColor(event.state))
                            Text(historyTimestamp(event.date)).font(.caption)
                            if let message = event.message { Text(message).font(.footnote) }
                            if let code = event.httpStatus { Text("HTTP \(code)").font(.caption).foregroundStyle(.secondary) }
                        }
                    }
                }
                if let batchID = entry.batchID { Section("批次") { Text(batchID).font(.caption) } }
            } else if loading { ProgressView("正在读取…") }
            else { Text(error ?? "该记录已超过保留期限").foregroundStyle(.secondary) }
        }.navigationTitle("同步详情")
            .task { await load() }
            .onReceive(NotificationCenter.default.publisher(for: .syncHistoryChanged).receive(on: RunLoop.main)) { notification in
                if notification.userInfo?["path"] as? String == history.file.path { Task { await load() } }
            }
    }
    private func load() async {
        loading = true
        let result = await Task.detached { Result { try history.detail(entryID) } }.value
        loading = false
        switch result {
        case .success(let value): detail = value; error = nil
        case .failure: error = "历史记录暂不可读，请解锁设备后重新打开。原文件已保留。"
        }
    }
}

private func historyDay(_ day: Date) -> String {
    if Calendar.current.isDateInToday(day) { return "今天" }
    if Calendar.current.isDateInYesterday(day) { return "昨天" }
    return day.formatted(.dateTime.month(.twoDigits).day(.twoDigits))
}
private func historyTimestamp(_ date: Date) -> String { date.formatted(.dateTime.year().month(.twoDigits).day(.twoDigits).hour().minute().second()) }
private func historyDate(_ label: String, _ date: Date) -> some View {
    VStack(alignment: .leading, spacing: 2) { Text(label).font(.caption).foregroundStyle(.secondary); Text(historyTimestamp(date)).font(.footnote) }
}
private func historyTimeLabel(_ state: SyncHistoryState) -> String {
    switch state { case .succeeded: "同步时间"; case .queued: "排队时间"; case .sending: "发送时间"; case .failed: "失败时间"; case .cancelled: "取消时间" }
}
private func historyKind(_ kind: SyncHistoryContext.Kind) -> String {
    switch kind { case .daily: "日常同步"; case .backfill: "历史补传"; case .workout: "运动实时摘要"; case .legacy: "旧版记录" }
}
private func historyIcon(_ state: SyncHistoryState) -> String {
    switch state { case .succeeded: "checkmark.circle.fill"; case .failed: "exclamationmark.circle.fill"; case .cancelled: "xmark.circle"; case .queued: "clock"; case .sending: "arrow.up.circle" }
}
private func historyColor(_ state: SyncHistoryState) -> Color {
    switch state { case .succeeded: .green; case .failed: .red; case .cancelled: .secondary; case .queued, .sending: .orange }
}
private func historyMetricValue(_ metric: SyncHistorySummary.Metric) -> String {
    guard let value = metric.latestValue else { return metric.detail ?? "暂无" }
    if metric.typeIdentifier == "HKWorkoutType" { return "\(Int(value) / 60)分\(Int(value) % 60)秒（该次累计）" }
    let unit = ["count/min": "次/分", "count": metric.typeIdentifier.contains("StepCount") ? "步" : "次", "ms": "ms", "s": "秒"][metric.unit ?? ""] ?? metric.unit ?? ""
    return value.formatted(.number.precision(.fractionLength(0...2))) + " " + unit
}
