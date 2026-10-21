import SwiftUI
import UniformTypeIdentifiers
import HealthRelayCore

struct ConfigurationDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.json] }
    var data: Data
    init(data: Data = Data()) { self.data = data }
    init(configuration: ReadConfiguration) throws {
        guard let data = configuration.file.regularFileContents else { throw ConfigurationError("无法读取配置文件") }
        self.data = data
    }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: data) }
}

private struct ConfigurationInput: Identifiable {
    let id = UUID()
    var data: Data?
}

struct AutomationListView: View {
    @Bindable var store: AutomationStore
    @State private var viewing: AutomationConfig?
    @State private var editing: AutomationConfig?
    @State private var signatureSetup = false
    @State private var importing = false
    @State private var importInput: ConfigurationInput?
    @State private var exporting = false
    @State private var exportDocument = ConfigurationDocument()
    @State private var exportName = "healthrelay-task"
    @State private var error: String?
    @State private var deleting: AutomationConfig?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Label("选择数据，上传到你的接口", systemImage: "slider.horizontal.3")
                        .font(.headline)
                    Text("支持手动上报、健康数据变化触发和系统后台调度。新任务保存后默认关闭。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if let reminderError = store.reminderError {
                    Section { Text(reminderError).font(.footnote).foregroundStyle(.orange) }
                }
                if store.waitingForProtectedData {
                    Section { Text("设备解锁后会自动恢复读取配置和同步。") }
                } else if let failure = store.loadError {
                    Section { Label("无法读取本地配置", systemImage: "exclamationmark.triangle"); Text(failure).font(.footnote) }
                } else if store.tasks.isEmpty {
                    Section {
                        ContentUnavailableView("创建你的第一个自动化", systemImage: "arrow.triangle.2.circlepath", description: Text("选择健康数据，设置导出规则和接收接口。"))
                        Button("新建自动化", systemImage: "plus") { editing = .newTask() }
                            .accessibilityIdentifier("new-task-empty")
                    }
                } else {
                    Section("任务 · \(store.tasks.count)") {
                        ForEach(store.tasks) { task in
                            HStack {
                                Button { editing = task } label: { taskRow(task) }
                                    .accessibilityIdentifier("task-\(task.name)")
                                Button { viewing = task } label: { Image(systemName: "play.circle").font(.title2) }
                                    .accessibilityLabel("运行与日志")
                                    .accessibilityIdentifier("run-task-\(task.name)")
                            }
                                .buttonStyle(.plain)
                                .contextMenu {
                                    Button("运行与日志", systemImage: "play.circle") { viewing = task }
                                    Button("编辑", systemImage: "pencil") { editing = task }
                                    Button("复制", systemImage: "doc.on.doc") { editing = task.duplicated() }
                                    if task.device == .iPhone {
                                        Button("复制为 Apple Watch", systemImage: "applewatch") {
                                            do { editing = try ConfigurationExchange.watchCopy(task) }
                                            catch { self.error = error.localizedDescription }
                                        }
                                    }
                                    Button("导出配置", systemImage: "square.and.arrow.up") { export(task) }
                                    Button("删除", systemImage: "trash", role: .destructive) { deleting = task }
                                }
                                .swipeActions {
                                    Button("删除", role: .destructive) { deleting = task }
                                    Button("导出") { export(task) }.tint(.teal)
                                }
                        }
                    }
                }
                Section("健康动态签名") {
                    NavigationLink {
                        SyncHistoryView(history: store.history, notice: { store.journal.historyError })
                    } label: { Label("同步历史", systemImage: "clock.arrow.circlepath") }
                        .accessibilityIdentifier("sync-history")
                    Button("配置健康签名同步", systemImage: "heart.text.clipboard") { signatureSetup = true }
                        .accessibilityIdentifier("setup-health-signature")
                        .disabled(!store.configurationReady)
                    Text("将 HRV、心率、睡眠和运动记录同步到你的服务，用于更新飞书动态签名。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section("Apple Watch") {
                    Button("同步 Watch 配置（不含认证）", systemImage: "applewatch") {
                        do { try store.syncWatch() } catch { self.error = error.localizedDescription }
                    }.disabled(store.loadError != nil)
                    Text(store.watchSync.status).font(.footnote)
                    Text("复制为 Watch 会创建独立且关闭的任务。切换执行设备前，请检查两端任务的启用状态，避免重复上传。")
                        .font(.caption).foregroundStyle(.secondary)
                    Text("发送全部 Watch 任务，不包含认证值。Watch 收到后默认关闭；在手表填写认证、授权并启用。移除也以本次完整列表为准。").font(.caption).foregroundStyle(.secondary)
                }
                Section {
                    Button("粘贴 JSON", systemImage: "curlybraces") { importInput = ConfigurationInput() }
                        .accessibilityIdentifier("paste-configuration")
                        .disabled(!store.configurationReady)
                    Button("从 JSON 导入", systemImage: "square.and.arrow.down") { importing = true }
                        .accessibilityIdentifier("import-task")
                        .disabled(!store.configurationReady)
                    Button("导出全部配置", systemImage: "square.and.arrow.up") {
                        exportData(name: "healthrelay-automations") { try ConfigurationExchange.export(store.tasks) }
                    }.disabled(store.tasks.isEmpty).accessibilityIdentifier("export-all-configurations")
                    Button("导出 AI 配置参考", systemImage: "doc.text") {
                        exportData(name: "healthrelay-ai-reference") { try ConfigurationExchange.reference() }
                    }.accessibilityIdentifier("export-configuration-reference")
                } footer: {
                    Text("配置文件不包含健康数据。导出时移除认证值；导入任务默认关闭，需在本机重新填写认证。")
                }
            }
            .navigationTitle("自动化")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("新建", systemImage: "plus") { editing = .newTask() }
                        .accessibilityIdentifier("new-task")
                        .disabled(!store.configurationReady)
                }
            }
            .sheet(isPresented: $signatureSetup) {
                NavigationStack { HealthSignatureSetupView(store: store) }
            }
            .sheet(item: $viewing) { task in
                NavigationStack { TaskExecutionView(store: store, taskID: task.id) }
            }
            .sheet(item: $editing) { task in
                NavigationStack { AutomationEditorView(store: store, initial: task) }
            }
            .sheet(item: $importInput) { input in
                NavigationStack {
                    ConfigurationImportView(store: store, data: input.data) { task in
                        importInput = nil
                        DispatchQueue.main.async { editing = task }
                    }
                }
            }
            .onChange(of: store.reminderRoute?.id, initial: true) { _, _ in
                guard let route = store.reminderRoute else { return }
                editing = nil; importInput = nil; viewing = nil
                store.reminderRoute = nil
                DispatchQueue.main.async {
                    viewing = store.tasks.first { $0.id == route.taskID && $0.enabled }
                }
            }
            .fileImporter(isPresented: $importing, allowedContentTypes: [.json]) { result in
                do {
                    let url = try result.get()
                    let access = url.startAccessingSecurityScopedResource()
                    defer { if access { url.stopAccessingSecurityScopedResource() } }
                    let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                    guard size <= ConfigurationExchange.maximumInputBytes else { throw ConfigurationError("配置文件超过 1 MiB") }
                    let data = try Data(contentsOf: url)
                    guard data.count <= ConfigurationExchange.maximumInputBytes else { throw ConfigurationError("配置文件超过 1 MiB") }
                    importInput = ConfigurationInput(data: data)
                } catch { self.error = error.localizedDescription }
            }
            .fileExporter(isPresented: $exporting, document: exportDocument, contentType: .json, defaultFilename: exportName) { result in
                if case .failure(let failure) = result { error = failure.localizedDescription }
            }
            .alert("操作失败", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("知道了") { error = nil }
            } message: { Text(error ?? "") }
            .confirmationDialog("删除这个自动化配置？", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
                Button("删除配置和待上传批次", role: .destructive) {
                    guard let task = deleting else { return }
                    do { try store.delete(task) } catch { self.error = error.localizedDescription }
                    deleting = nil
                }
                Button("取消", role: .cancel) { deleting = nil }
            }
        }
    }

    private func taskRow(_ task: AutomationConfig) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: "arrow.up.doc.fill").foregroundStyle(.teal)
                Text(task.name).font(.headline).foregroundStyle(.primary)
                Spacer()
                Text(task.enabled ? "已启用" : "已关闭").font(.caption).foregroundStyle(.secondary)
            }
            Text("\(task.device.title) · \(task.data.family.title) · \(task.data.selections.count) 项 · \(task.range.mode.title)")
                .font(.subheadline).foregroundStyle(.secondary)
            Text(URL(string: task.destination.url)?.host ?? task.destination.url)
                .font(.caption).foregroundStyle(.secondary).lineLimit(1)
        }.padding(.vertical, 6)
    }

    private func exportData(name: String, data: () throws -> Data) {
        do {
            exportDocument = ConfigurationDocument(data: try data())
            exportName = name
            exporting = true
        } catch { self.error = error.localizedDescription }
    }

    private func export(_ task: AutomationConfig) {
        do {
            exportDocument = ConfigurationDocument(data: try ConfigurationCodec.export(task))
            exportName = "healthrelay-\(task.id.uuidString.lowercased())"
            exporting = true
        } catch { self.error = error.localizedDescription }
    }
}

private struct HealthSignatureSetupView: View {
    let store: AutomationStore
    @Environment(\.dismiss) private var dismiss
    @State private var endpoint = ""
    @State private var key = ""
    @State private var error: String?
    var body: some View {
        Form {
            Section("本地服务") {
                TextField("HTTPS 接口地址", text: $endpoint)
                    .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .accessibilityIdentifier("signature-endpoint")
                SecureField("服务认证值", text: $key)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .accessibilityIdentifier("signature-service-key")
            }
            Section {
                Text("创建两个独立任务：健康指标与锻炼。首次同步读取最近 30 天，之后增量同步；认证保存在本机钥匙串。")
                Text("创建后，在每个任务的“运行与日志”中授权健康读取、执行首次上传并启用自动化。手机需能访问服务；iOS 决定后台运行时机。")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            Button("创建同步任务") {
                do { try store.installHealthSignature(endpoint: endpoint, key: key); dismiss() }
                catch { self.error = error.localizedDescription }
            }.disabled(endpoint.isEmpty || key.isEmpty).accessibilityIdentifier("create-signature-tasks")
        }
        .navigationTitle("健康签名同步").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } } }
        .alert("创建失败", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("知道了") { error = nil }
        } message: { Text(error ?? "") }
    }
}
