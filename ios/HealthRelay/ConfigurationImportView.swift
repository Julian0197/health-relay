import SwiftUI
import HealthRelayCore

struct ConfigurationImportView: View {
    let store: AutomationStore
    let onEdit: (AutomationConfig) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var json: String
    @State private var inspection: ConfigurationInspection?
    @State private var error: String?
    @FocusState private var editingJSON: Bool

    init(store: AutomationStore, data: Data? = nil, onEdit: @escaping (AutomationConfig) -> Void) {
        self.store = store
        self.onEdit = onEdit
        _json = State(initialValue: data.map { String(decoding: $0, as: UTF8.self) } ?? "")
        _inspection = State(initialValue: data.map { ConfigurationExchange.inspect($0, systemMajorVersion: ProcessInfo.processInfo.operatingSystemVersion.majorVersion) })
    }

    var body: some View {
        Form {
            Section {
                TextEditor(text: $json)
                    .font(.system(.caption, design: .monospaced))
                    .frame(height: 200)
                    .keyboardType(.asciiCapable)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($editingJSON)
                    .accessibilityLabel("JSON 配置")
                    .accessibilityIdentifier("configuration-json")
                    .onChange(of: json) { _, _ in inspection = nil }
            } header: { Text("粘贴 JSON") } footer: {
                Text("支持单个任务或配置包，最多 1 MiB。修改后请重新检查；认证值不会随配置导入。")
            }
            if let report = inspection {
                Section {
                    Text(report.valid ? "配置检查通过" : "配置需要修正")
                        .accessibilityIdentifier(report.valid ? "configuration-valid" : "configuration-invalid")
                    Text("检查通过仅表示配置有效，不代表已获健康数据权限、认证可用或上传成功。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                ForEach(Array(report.tasks.enumerated()), id: \.offset) { index, task in
                    Section("任务 \(index + 1)") {
                        Text(preview(task))
                            .accessibilityIdentifier("preview-task-\(index)")
                    }
                }
                if !report.issues.isEmpty {
                    Section("检查结果") {
                        ForEach(Array(report.issues.enumerated()), id: \.offset) { index, issue in
                            Text("\(issue.severity == .error ? "错误" : "提醒") · \(issue.path.isEmpty ? "/" : issue.path)\n\(issue.message)")
                                .font(.footnote)
                                .foregroundStyle(issue.severity == .error ? .red : .secondary)
                                .accessibilityIdentifier("configuration-issue-\(index)")
                        }
                    }
                }
                if report.valid {
                    Section {
                        Button("全部导入为新任务（\(report.tasks.count) 个）") {
                            do { try store.importConfigurations(report); dismiss() }
                            catch { self.error = error.localizedDescription }
                        }
                        .disabled(!store.configurationReady)
                        .accessibilityIdentifier("import-new-configurations")
                    } footer: { Text("整批保存为独立的新任务，默认关闭。原有任务保持不变；请在执行设备上填写认证并确认启用状态。") }
                }
                if report.tasks.count == 1, let task = report.tasks.first {
                    Section {
                        Button("编辑并创建新任务") {
                            var copy = task
                            copy.id = UUID(); copy.revision = 1
                            onEdit(copy)
                        }
                        .accessibilityIdentifier("edit-imported-configuration")
                        if let existing = store.tasks.first(where: { $0.id == task.id }) {
                            Text("现有任务：\(existing.name)。进入编辑页检查后，保存将更新此任务。")
                                .font(.footnote).foregroundStyle(.secondary)
                            Button("检查并更新现有任务") { onEdit(task) }
                                .accessibilityIdentifier("update-imported-configuration")
                        }
                    }
                }
            }
        }
        .navigationTitle("导入配置")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("取消") { dismiss() }.accessibilityIdentifier("cancel-configuration-import")
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("检查配置") {
                    editingJSON = false
                    inspection = ConfigurationExchange.inspect(Data(json.utf8), systemMajorVersion: ProcessInfo.processInfo.operatingSystemVersion.majorVersion)
                }.accessibilityIdentifier("check-configuration")
            }
        }
        .alert("导入失败", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("知道了") { error = nil }
        } message: { Text(error ?? "") }
    }

    private func preview(_ task: AutomationConfig) -> String {
        let metrics = task.data.selections.map { MetricCatalog.bundled.metric($0.id)?.title ?? $0.id }.joined(separator: "、")
        let host = URL(string: task.destination.url)?.host ?? "无有效主机"
        let headers = Set([task.destination.credentialHeader].compactMap { $0 } + (task.destination.requiredSecretHeaders ?? [])).sorted()
        let authentication = headers.isEmpty ? "未声明认证 Header" : headers.joined(separator: "、")
        return "名称：\(task.name)\n设备：\(task.device.title)\n指标：\(metrics)\n最小间隔：\(task.execution.minimumIntervalSeconds) 秒\n接收主机：\(host)\n认证要求：\(authentication)\n导入状态：已关闭"
    }
}
