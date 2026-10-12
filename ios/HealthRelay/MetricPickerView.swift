import SwiftUI
import HealthKit
import HealthRelayCore

struct MetricPickerView: View {
    @Binding var selections: [MetricSelection]
    let family: DataFamily
    @Environment(\.dismiss) private var dismiss
    @State private var search = ""
    private var metrics: [MetricDescriptor] { MetricCatalog.bundled.search(search, family: family) }
    private var currentIOS: Int { ProcessInfo.processInfo.operatingSystemVersion.majorVersion }

    var body: some View {
        List {
            Section {
                HStack {
                    Text("已选 \(selections.count) 项").foregroundStyle(.secondary)
                    Spacer()
                    Button("全选可用") {
                        for metric in metrics where metric.minimumIOS <= currentIOS {
                            if !selections.contains(where: { $0.id == metric.id }) { selections.append(metric.selection) }
                        }
                    }
                    Button("清空", role: .destructive) { selections = [] }
                }.font(.subheadline)
            }
            ForEach(Array(Set(metrics.map(\.category))).sorted(), id: \.self) { category in
                Section(category) {
                    ForEach(metrics.filter { $0.category == category }) { metric in
                        let selected = selections.contains { $0.id == metric.id }
                        Button {
                            if selected { selections.removeAll { $0.id == metric.id } }
                            else { selections.append(metric.selection) }
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(metric.title).foregroundStyle(.primary)
                                    if metric.minimumIOS > currentIOS {
                                        Text("需要 iOS \(metric.minimumIOS)").font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                                Spacer()
                                Image(systemName: selected ? "checkmark.circle.fill" : "circle").foregroundStyle(selected ? .teal : .secondary)
                            }.padding(.vertical, 3)
                        }
                        .disabled(metric.minimumIOS > currentIOS)
                        .accessibilityIdentifier("metric-\(metric.id)")
                    }
                }
            }
        }
        .navigationTitle("选择数据")
        .searchable(text: $search, prompt: "搜索指标、分类或标识符")
        .safeAreaInset(edge: .bottom) {
            HStack {
                Text("已选择 \(selections.count) 项").font(.subheadline).foregroundStyle(.secondary)
                Spacer()
                Button("完成选择") { dismiss() }.buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("metrics-done")
            }.padding().background(.bar)
        }
    }
}

struct SourcePickerView: View {
    let metric: MetricDescriptor
    @Binding var selected: [String]
    @State private var sources: [(id: String, name: String)] = []
    @State private var message = ""
    @State private var loading = false

    var body: some View {
        List {
            Section {
                Text("不选择来源表示使用全部未被排除的来源。选择多个来源表示包含它们，不表示优先级。")
                    .font(.footnote).foregroundStyle(.secondary)
                Button("使用全部来源") { selected = [] }
                Button("从健康读取来源") { Task { await load() } }
                    .disabled(loading)
                if loading { ProgressView() }
                if !message.isEmpty { Text(message).font(.footnote).foregroundStyle(.secondary) }
            }
            Section("来源") {
                ForEach(sources, id: \.id) { source in
                    Button {
                        if selected.contains(source.id) { selected.removeAll { $0 == source.id } }
                        else { selected.append(source.id) }
                    } label: {
                        HStack {
                            Text(source.name).foregroundStyle(.primary)
                            Spacer()
                            if selected.contains(source.id) { Image(systemName: "checkmark").foregroundStyle(.teal) }
                        }
                    }
                }
            }
            if !selected.isEmpty {
                Section("已配置来源标识符") {
                    ForEach(selected, id: \.self) { id in Text(id).font(.caption).textSelection(.enabled) }
                }
            }
        }.navigationTitle("数据来源")
    }

    @MainActor private func load() async {
        guard HKHealthStore.isHealthDataAvailable() else { message = "此设备无法访问健康数据。"; return }
        let type: HKSampleType?
        switch metric.family {
        case .healthMetrics: type = nil
        case .quantity: type = HKObjectType.quantityType(forIdentifier: .init(rawValue: metric.id))
        case .category: type = HKObjectType.categoryType(forIdentifier: .init(rawValue: metric.id))
        case .correlation: type = HKObjectType.correlationType(forIdentifier: .init(rawValue: metric.id))
        case .workout: type = HKObjectType.workoutType()
        }
        guard let type else { message = "当前系统不支持该数据类型。"; return }
        loading = true; defer { loading = false }
        do {
            let health = HKHealthStore()
            let readTypes: Set<HKObjectType>
            if metric.family == .correlation {
                message = "关联记录来源选择将在对应读取器接入后开放。"; return
            } else { readTypes = [type] }
            try await health.requestAuthorization(toShare: [], read: readTypes)
            let results: [HKSource] = try await withCheckedThrowingContinuation { continuation in
                let query = HKSourceQuery(sampleType: type, samplePredicate: nil) { _, found, error in
                    if let error { continuation.resume(throwing: error) }
                    else { continuation.resume(returning: Array(found ?? [])) }
                }
                health.execute(query)
            }
            sources = results.map { (id: $0.bundleIdentifier, name: $0.name) }.sorted { $0.name < $1.name }
            message = sources.isEmpty ? "未读到来源。可能没有记录，也可能尚未允许读取；可到健康 App 检查。" : ""
        } catch { message = error.localizedDescription }
    }
}
