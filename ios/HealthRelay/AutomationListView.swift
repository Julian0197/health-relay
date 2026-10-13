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

struct AutomationListView: View {
    @Bindable var store: AutomationStore
    @State private var viewing: AutomationConfig?
    @State private var editing: AutomationConfig?
    @State private var importing = false
    @State private var importCandidate: AutomationConfig?
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
                Section {
                    Button("从 JSON 导入", systemImage: "square.and.arrow.down") { importing = true }
                        .accessibilityIdentifier("import-task")
                        .disabled(!store.configurationReady)
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
            .sheet(item: $viewing) { task in
                NavigationStack { TaskExecutionView(store: store, taskID: task.id) }
            }
            .sheet(item: $editing) { task in
                NavigationStack { AutomationEditorView(store: store, initial: task) }
            }
            .sheet(item: $importCandidate) { task in
                NavigationStack {
                    List {
                        Section("配置预览") {
                            LabeledContent("名称", value: task.name)
                            LabeledContent("数据类型", value: task.data.family.title)
                            LabeledContent("指标", value: "\(task.data.selections.count) 项")
                            LabeledContent("接口", value: task.destination.url)
                            Text("导入后任务关闭，认证信息需重新填写。进入编辑页检查后保存。")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                        Button("创建为新任务") {
                            var copy = task; copy.id = UUID(); copy.revision = 1
                            importCandidate = nil
                            DispatchQueue.main.async { editing = copy }
                        }
                        if let existing = store.tasks.first(where: { $0.id == task.id }) {
                            Section("当前任务：\(existing.name)") {
                                Text("保存后将更新这个任务，不修改其他任务。")
                                Button("检查并更新现有任务") {
                                    importCandidate = nil
                                    DispatchQueue.main.async { editing = task }
                                }
                            }
                        }
                    }
                    .navigationTitle("导入配置")
                    .toolbar { Button("取消") { importCandidate = nil } }
                }
            }
            .onChange(of: store.reminderRoute?.id, initial: true) { _, _ in
                guard let route = store.reminderRoute else { return }
                editing = nil; importCandidate = nil; viewing = nil
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
                    guard size <= 1_048_576 else { throw ConfigurationError("配置文件超过 1 MiB") }
                    importCandidate = try ConfigurationCodec.decode(Data(contentsOf: url))
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
            Text("\(task.data.family.title) · \(task.data.selections.count) 项 · \(task.range.mode.title)")
                .font(.subheadline).foregroundStyle(.secondary)
            Text(URL(string: task.destination.url)?.host ?? task.destination.url)
                .font(.caption).foregroundStyle(.secondary).lineLimit(1)
        }.padding(.vertical, 6)
    }

    private func export(_ task: AutomationConfig) {
        do {
            exportDocument = ConfigurationDocument(data: try ConfigurationCodec.export(task))
            exportName = "healthrelay-\(task.id.uuidString.lowercased())"
            exporting = true
        } catch { self.error = error.localizedDescription }
    }
}
