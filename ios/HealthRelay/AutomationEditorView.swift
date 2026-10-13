import SwiftUI
import HealthRelayCore

private struct HeaderDraft: Identifiable {
    let id = UUID()
    var name: String
    var value: String
    var secret: Bool
    var existingReference: String?
}

struct AutomationEditorView: View {
    let store: AutomationStore
    @Environment(\.dismiss) private var dismiss
    @State private var task: AutomationConfig
    @State private var headers: [HeaderDraft]
    @State private var credentialValue = ""
    @State private var error: String?
    @State private var preview = false

    init(store: AutomationStore, initial: AutomationConfig) {
        self.store = store
        _task = State(initialValue: initial)
        var entries = initial.destination.headers.sorted { $0.key < $1.key }.map {
            HeaderDraft(name: $0.key, value: $0.value, secret: ConfigurationCodec.isSensitiveHeader($0.key))
        }
        entries += (initial.destination.secretHeaders ?? [:]).sorted { $0.key < $1.key }.map {
            HeaderDraft(name: $0.key, value: "", secret: true, existingReference: $0.value)
        }
        for name in initial.destination.requiredSecretHeaders ?? [] where !entries.contains(where: { $0.name == name }) {
            entries.append(HeaderDraft(name: name, value: "", secret: true))
        }
        _headers = State(initialValue: entries)
    }

    private var issues: [String] { candidate.validationIssues(systemMajorVersion: task.device == .watch ? 27 : ProcessInfo.processInfo.operatingSystemVersion.majorVersion, device: task.device) + headerIssues }
    private var headerIssues: [String] {
        let filled = headers.filter { !$0.name.isEmpty }
        let names = filled.map { $0.name.lowercased() }
        var result: [String] = []
        if Set(names).count != names.count { result.append("Header 名称不能重复") }
        for header in headers {
            if header.name.isEmpty && (!header.value.isEmpty || header.existingReference != nil) { result.append("请填写 Header 名称") }
            if !header.name.isEmpty && header.value.isEmpty && header.existingReference == nil && !(task.device == .watch && (header.secret || ConfigurationCodec.isSensitiveHeader(header.name))) { result.append("请填写 \(header.name) 的值") }
            if AutomationConfig.containsHeaderLineBreak(header.value) { result.append("Header 值不能包含换行") }
        }
        if let authName = task.destination.credentialHeader, !authName.isEmpty,
           names.contains(authName.lowercased()) { result.append("认证 Header 与自定义 Header 重复") }
        if AutomationConfig.containsHeaderLineBreak(credentialValue) { result.append("认证值不能包含换行") }
        if task.device == .iPhone && task.destination.credentialHeader != nil && credentialValue.isEmpty && task.destination.credentialRef == nil {
            result.append("请填写认证值，或关闭认证")
        }
        return result
    }
    private var candidate: AutomationConfig {
        var copy = task
        copy.destination.headers = headers.reduce(into: [:]) { result, item in
            if !item.name.isEmpty { result[item.name] = item.secret ? "saved-in-keychain" : item.value }
        }
        return copy
    }

    var body: some View {
        Form {
            Section {
                TextField("任务名称", text: $task.name).accessibilityIdentifier("task-name")
                Picker("执行设备", selection: $task.device) {
                    ForEach(ExecutionDevice.allCases, id: \.self) { Text($0.title).tag($0) }
                }
                LabeledContent("状态", value: task.enabled ? "已启用" : "已关闭")
            } header: { Text("任务") } footer: { Text("新任务默认关闭。保存后可手动运行，或在运行页启用自动化。") }
            dataSection
            rangeSection
            exportSection
            destinationSection
            headerSection
            executionSection
            Section {
                NavigationLink { ReminderEditorView(settings: $task.execution.reminder) } label: {
                    LabeledContent("安排提醒", value: task.execution.reminder?.enabled == true ? "已开启" : "已关闭")
                }.accessibilityIdentifier("reminder-settings")
            }
            if !task.executionIssues.isEmpty {
                Section("执行能力") {
                    ForEach(task.executionIssues, id: \.self) { Text($0).font(.footnote).foregroundStyle(.secondary) }
                }
            }
            Section {
                Button("预览 JSON 配置", systemImage: "curlybraces") { preview = true }
            }
            if !issues.isEmpty {
                Section("保存前需要完善") {
                    ForEach(Array(issues.enumerated()), id: \.offset) { _, issue in
                        Label(issue, systemImage: "exclamationmark.circle").font(.footnote).foregroundStyle(.orange)
                    }
                }
            }
        }
        .navigationTitle(store.tasks.contains(where: { $0.id == task.id }) ? "编辑自动化" : "新建自动化")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                Button("保存") { save() }.disabled(!issues.isEmpty).accessibilityIdentifier("save-task")
            }
        }
        .sheet(isPresented: $preview) {
            NavigationStack {
                ScrollView {
                    Text(String(decoding: (try? ConfigurationCodec.export(candidate)) ?? Data(), as: UTF8.self))
                        .font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading).padding()
                }.navigationTitle("配置预览")
                    .toolbar { Button("完成") { preview = false } }
            }
        }
        .alert("保存失败", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("知道了") { error = nil }
        } message: { Text(error ?? "") }
    }

    private var dataSection: some View {
        Section("数据") {
            Picker("数据类型", selection: $task.data.family) {
                ForEach(DataFamily.allCases, id: \.self) { Text($0.title).tag($0) }
            }.onChange(of: task.data.family) { _, _ in
                task.data.selections = []
                task.data.workoutOptions = task.data.family == .workout ? WorkoutOptions() : nil
                task.export.mode = .raw; task.export.grouping = .none; task.export.statistics = []
            }
            NavigationLink {
                MetricPickerView(selections: $task.data.selections, family: task.data.family)
            } label: {
                LabeledContent("选择数据", value: "\(task.data.selections.count) 项")
            }.accessibilityIdentifier("metric-picker")
            ForEach($task.data.selections) { $selection in
                if let metric = MetricCatalog.bundled.metric(selection.id) {
                    NavigationLink {
                        MetricSettingsView(metric: metric, selection: $selection)
                    } label: {
                        LabeledContent(metric.title, value: selection.unit ?? "明细")
                    }
                } else {
                    HStack {
                        Text("未知指标：\(selection.id)").font(.caption)
                        Button("移除") { task.data.selections.removeAll { $0.id == selection.id } }
                    }
                }
            }.onDelete { task.data.selections.remove(atOffsets: $0) }
            NavigationLink("排除来源（\(task.data.excludedSources.count)）") {
                SourceExclusionView(sources: $task.data.excludedSources)
            }
            if task.data.family == .workout {
                Toggle("包含运动路线", isOn: Binding(get: { task.data.workoutOptions?.includeRoutes ?? false }, set: { value in
                    var options = task.data.workoutOptions ?? WorkoutOptions(); options.includeRoutes = value; task.data.workoutOptions = options
                }))
                Toggle("包含运动关联指标", isOn: Binding(get: { task.data.workoutOptions?.includeMetrics ?? false }, set: { value in
                    var options = task.data.workoutOptions ?? WorkoutOptions(); options.includeMetrics = value; task.data.workoutOptions = options
                }))
                if task.data.workoutOptions?.includeMetrics == true {
                    Picker("运动指标分组", selection: Binding(get: { task.data.workoutOptions?.metricGrouping ?? "minutes" }, set: { value in
                        var options = task.data.workoutOptions ?? WorkoutOptions(); options.metricGrouping = value; task.data.workoutOptions = options
                    })) { Text("分钟").tag("minutes"); Text("秒").tag("seconds") }
                }
            }
        }
    }

    private var rangeSection: some View {
        Section("日期范围") {
            Picker("读取范围", selection: $task.range.mode) {
                ForEach(DateRange.Mode.allCases, id: \.self) { Text($0.title).tag($0) }
            }.onChange(of: task.range.mode) { _, mode in
                task.range = DateRange(mode: mode, bootstrapDays: mode == .incremental ? 7 : nil, days: (mode == .pastDays || mode == .previousDays) ? 7 : nil,
                    start: mode == .custom ? Date().addingTimeInterval(-86400).ISO8601Format() : nil,
                    end: mode == .custom ? Date().ISO8601Format() : nil)
            }
            if task.range.mode == .incremental {
                Stepper("首次读取过去 \(task.range.bootstrapDays ?? 7) 天", value: Binding(get: { task.range.bootstrapDays ?? 7 }, set: { task.range.bootstrapDays = $0 }), in: 1...3650)
                Text("以后按健康数据变更继续读取；不是每次只查询最近这几天。")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            if task.range.mode == .pastDays || task.range.mode == .previousDays {
                Stepper("过去 \(task.range.days ?? 7) 天", value: Binding(get: { task.range.days ?? 7 }, set: { task.range.days = $0 }), in: 1...3650)
            }
            if task.range.mode == .custom {
                DatePicker("开始", selection: dateBinding(start: true))
                DatePicker("结束", selection: dateBinding(start: false))
            }
            TextField("时区", text: $task.export.timeZone).textInputAutocapitalization(.never).autocorrectionDisabled()
        }
    }

    private var exportSection: some View {
        Section {
            Picker("导出格式", selection: $task.export.format) {
                Text("HealthRelay JSON · v1").tag("healthrelay.v1")
                Text("HEA JSON · v2").tag("hea.v2")
                Text("HEA CSV · 实验性").tag("hea.csv")
                Text("HEA JSON · v1").tag("hea.v1")
                Text("HealthRelay CSV").tag("csv")
                Text("Markdown").tag("markdown")
            }.accessibilityIdentifier("export-format")
            .onChange(of: task.export.format) { _, format in
                if format.hasPrefix("hea."), task.export.deletionPolicy == nil { task.export.deletionPolicy = .reject }
                if format == "hea.csv", task.supportsAggregation {
                    task.export.mode = .aggregate
                    if task.export.grouping == .none { task.export.grouping = .days }
                }
            }
            if task.export.format.hasPrefix("hea.") {
                Picker("HEA 数据类型", selection: Binding(get: { task.export.heaDataType ?? .automatic }, set: { task.export.heaDataType = $0 == .automatic ? nil : $0 })) {
                    ForEach(HEADataType.allCases, id: \.self) { Text($0.title).tag($0) }
                }.accessibilityIdentifier("hea-data-type")
                Text("自动按记录选择结构；同一种记录用于不同导出时，可指定健康指标、症状或周期记录。")
                    .font(.footnote).foregroundStyle(.secondary)
                if task.export.format == "hea.csv" {
                    Text("仅支持健康指标汇总，每指标一个文件；与 HEA 手动导出的合并表格布局不同。需要兼容 HEA 时请使用 JSON。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Picker("健康记录被删除时", selection: Binding(get: { task.export.deletionPolicy ?? .reject }, set: { task.export.deletionPolicy = $0 })) {
                    Text("停止并提示").tag(ExportSettings.DeletionPolicy.reject)
                    Text("跳过删除事件").tag(ExportSettings.DeletionPolicy.omit)
                }
                Text("HEA 格式无法撤回已上传的记录。跳过删除时会记入日志；需要完整增删同步请用 HealthRelay JSON。汇总仍会发送有剩余值的修正窗口。")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            Picker("数据形式", selection: $task.export.mode) {
                Text("原始明细").tag(ExportSettings.Mode.raw).disabled(task.export.format == "hea.csv")
                Text("汇总数据").tag(ExportSettings.Mode.aggregate).disabled(!task.supportsAggregation)
            }.onChange(of: task.export.mode) { _, mode in
                task.export.grouping = mode == .raw ? .none : .days
                task.export.statistics = []
            }
            if task.export.mode == .aggregate {
                Picker("时间分组", selection: $task.export.grouping) {
                    ForEach(ExportSettings.Grouping.allCases.filter { $0 != .none }, id: \.self) { Text($0.title).tag($0) }
                }
                if !task.export.statistics.isEmpty {
                    Text("此旧配置使用统一统计：" + task.export.statistics.map(\.rawValue).joined(separator: "、"))
                        .font(.footnote)
                    Button("改用每指标默认统计") { task.export.statistics = [] }
                }
                Text("各指标独立统计：累计量求和，测量值取均值和极值。可进入指标设置单独选择。")
                    .font(.footnote).foregroundStyle(.secondary)
                if task.data.selections.contains(where: { $0.id == "HKCategoryTypeIdentifierSleepAnalysis" }) {
                    Text("睡眠按每天中午 12 点至次日中午归为一晚，不随上述数量指标分组；重叠时段去重。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
        } header: { Text("导出设置") } footer: {
            Text(task.supportsAggregation ? "明细保留每条记录；汇总查询完整时间窗口，迟到数据会修正该窗口。" : "汇总支持数量指标和睡眠；其他类型请使用明细。")
        }
    }

    private var destinationSection: some View {
        Section {
            TextField("https://example.com/ingest", text: $task.destination.url)
                .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                .accessibilityIdentifier("endpoint-url")
            LabeledContent("请求方式", value: "POST")
            Stepper("超时 \(task.destination.timeoutSeconds) 秒", value: $task.destination.timeoutSeconds, in: 5...300, step: 5)
            Picker("成功确认", selection: $task.destination.acknowledgement) {
                Text("HTTP 成功状态").tag(HTTPDestination.Acknowledgement.http2xx)
                Text("批次提交回执").tag(HTTPDestination.Acknowledgement.receipt)
            }
            Toggle("使用认证", isOn: Binding(get: { task.destination.credentialHeader != nil }, set: { enabled in
                if enabled { task.destination.credentialHeader = "Authorization"; task.destination.credentialPrefix = "Bearer " }
                else { task.destination.credentialHeader = nil; task.destination.credentialPrefix = nil; task.destination.credentialRef = nil; credentialValue = "" }
            }))
            if task.destination.credentialHeader != nil {
                TextField("认证 Header", text: Binding(get: { task.destination.credentialHeader ?? "" }, set: { task.destination.credentialHeader = $0 }))
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                TextField("前缀（例如 Bearer 后加空格）", text: Binding(get: { task.destination.credentialPrefix ?? "" }, set: { task.destination.credentialPrefix = $0 }))
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                SecureField(task.destination.credentialRef == nil ? "Token 或认证值" : "已保存；留空保持原值", text: $credentialValue)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
            }
        } header: { Text("HTTP 接口") } footer: {
            Text("回执模式要求接口支持 HealthRelay 批次协议。认证值仅保存在本机 Keychain，不随配置导出或 Watch 同步。Watch 任务可留空，到手表填写。")
        }
    }

    private var headerSection: some View {
        Section("自定义 Header") {
            ForEach($headers) { $header in
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        TextField("Header 名称", text: $header.name).textInputAutocapitalization(.never).autocorrectionDisabled()
                        Button(role: .destructive) { headers.removeAll { $0.id == header.id } } label: { Image(systemName: "minus.circle") }
                    }
                    if header.secret || ConfigurationCodec.isSensitiveHeader(header.name) {
                        SecureField(header.existingReference == nil ? "Header 值" : "已保存；留空保持原值", text: $header.value)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                    } else {
                        TextField("Header 值", text: $header.value).textInputAutocapitalization(.never).autocorrectionDisabled()
                    }
                    Toggle("作为认证值保存", isOn: $header.secret)
                        .font(.caption).disabled(ConfigurationCodec.isSensitiveHeader(header.name))
                }.onChange(of: header.name) { _, name in
                    if ConfigurationCodec.isSensitiveHeader(name) { header.secret = true }
                }
            }
            Button("添加 Header", systemImage: "plus.circle") { headers.append(HeaderDraft(name: "", value: "", secret: false)) }
        }
    }

    private var executionSection: some View {
        Section {
            Toggle("健康数据变化时处理", isOn: $task.execution.onDataChange)
            Toggle("打开 App 时检查", isOn: $task.execution.onForeground)
            Toggle("定期检查", isOn: Binding(get: { task.execution.periodicPolling ?? false }, set: { task.execution.periodicPolling = $0 }))
            Text("开启后，App 保持前台时按期望间隔检查；后台由 iOS 决定执行时机。无新数据时不上传。")
                .font(.footnote).foregroundStyle(.secondary)
            HStack {
                Text("期望间隔（分钟）")
                TextField("分钟", value: Binding(get: { task.execution.minimumIntervalSeconds / 60 }, set: { value in
                    task.execution.minimumIntervalSeconds = (1...10080).contains(value) ? value * 60 : 0
                }), format: .number)
                    .keyboardType(.numberPad).multilineTextAlignment(.trailing)
            }
            HStack {
                Text("每批最多记录")
                TextField("条", value: $task.execution.batchMaxRecords, format: .number).keyboardType(.numberPad).multilineTextAlignment(.trailing)
            }
            Stepper("每批最多 \(task.execution.batchMaxBytes / 1024) KiB", value: $task.execution.batchMaxBytes, in: 1024...10_485_760, step: 65_536)
            Toggle("失败时通知", isOn: Binding(get: { task.execution.notifyOnFailure ?? true }, set: { task.execution.notifyOnFailure = $0 }))
            Toggle("成功时通知", isOn: Binding(get: { task.execution.notifyOnSuccess ?? false }, set: { task.execution.notifyOnSuccess = $0 }))
        } header: { Text("执行偏好") } footer: { Text("iOS 决定后台执行时机，期望间隔不是准点计时器。数据变化和后台调度共用增量游标；失败批次保留等待重试。") }
    }

    private func dateBinding(start: Bool) -> Binding<Date> {
        Binding(get: { AutomationConfig.parseDate(start ? task.range.start : task.range.end) ?? Date() }, set: { date in
            if start { task.range.start = date.ISO8601Format() } else { task.range.end = date.ISO8601Format() }
        })
    }

    private func save() {
        guard issues.isEmpty else { return }
        var createdReferences: [String] = []
        do {
            var saved = task
            saved.destination.requiredSecretHeaders = nil
            saved.destination.headers = [:]; saved.destination.secretHeaders = [:]
            for header in headers where !header.name.isEmpty {
                if header.secret || ConfigurationCodec.isSensitiveHeader(header.name) {
                    if !header.value.isEmpty {
                        let ref = try store.credentials.save(header.value)
                        createdReferences.append(ref); saved.destination.secretHeaders?[header.name] = ref
                    } else if let ref = header.existingReference { saved.destination.secretHeaders?[header.name] = ref }
                    else if saved.device == .watch {
                        if saved.destination.requiredSecretHeaders == nil { saved.destination.requiredSecretHeaders = [] }
                        saved.destination.requiredSecretHeaders?.append(header.name)
                    }
                } else { saved.destination.headers[header.name] = header.value }
            }
            if saved.destination.credentialHeader != nil && !credentialValue.isEmpty {
                let ref = try store.credentials.save(credentialValue)
                createdReferences.append(ref); saved.destination.credentialRef = ref
            }
            let old = store.tasks.first { $0.id == saved.id }
            try store.save(saved)
            let retained = Set((saved.destination.secretHeaders ?? [:]).values).union([saved.destination.credentialRef].compactMap { $0 })
            if let old {
                let previous = Set((old.destination.secretHeaders ?? [:]).values).union([old.destination.credentialRef].compactMap { $0 })
                for ref in previous.subtracting(retained) { store.credentials.delete(ref) }
            }
            dismiss()
        } catch {
            for ref in createdReferences { store.credentials.delete(ref) }
            self.error = error.localizedDescription
        }
    }
}

private struct MetricSettingsView: View {
    let metric: MetricDescriptor
    @Binding var selection: MetricSelection
    private func statisticTitle(_ value: ExportSettings.Statistic) -> String {
        switch value { case .sum: "总和"; case .average: "平均"; case .minimum: "最小值"; case .maximum: "最大值" }
    }

    var body: some View {
        Form {
            Section {
                Text(metric.title).font(.headline)
                Text(metric.id).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                if !metric.units.isEmpty {
                    Picker("输出单位", selection: Binding(get: { selection.unit ?? metric.units[0] }, set: { selection.unit = $0 })) {
                        ForEach(metric.units, id: \.self) { Text($0).tag($0) }
                    }
                }
                if !metric.statistics.isEmpty {
                    Toggle("自定义汇总统计", isOn: Binding(get: { selection.statistics != nil }, set: { selection.statistics = $0 ? metric.statistics : nil }))
                    if selection.statistics != nil {
                        ForEach(metric.statistics, id: \.self) { statistic in
                            Toggle(statisticTitle(statistic), isOn: Binding(get: { selection.statistics?.contains(statistic) ?? false }, set: { enabled in
                                selection.statistics?.removeAll { $0 == statistic }
                                if enabled { selection.statistics?.append(statistic) }
                            }))
                        }
                    }
                }
                NavigationLink {
                    SourcePickerView(metric: metric, selected: $selection.sources)
                } label: { LabeledContent("来源", value: selection.sources.isEmpty ? "全部来源" : "\(selection.sources.count) 个") }
            }
        }.navigationTitle("指标设置")
    }
}

private struct SourceExclusionView: View {
    @Binding var sources: [String]
    @State private var text = ""
    var body: some View {
        Form {
            Section {
                TextEditor(text: $text).frame(minHeight: 160).font(.system(.body, design: .monospaced))
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
            } footer: { Text("每行一个来源标识符，作用于本任务的所有指标。可从指标来源页复制；排除优先于包含。") }
        }.navigationTitle("排除来源")
            .onAppear { text = sources.joined(separator: "\n") }
            .onChange(of: text) { _, value in
                sources = Array(Set(value.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty })).sorted()
            }
    }
}
