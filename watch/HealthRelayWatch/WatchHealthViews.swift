import SwiftUI
import HealthKit
import HealthRelayCore

struct WatchHealthSignatureSetupView: View {
    let store: WatchStore
    @Environment(\.dismiss) private var dismiss
    @State private var endpoint = ""
    @State private var key = ""
    @State private var error: String?
    @State private var saving = false
    var body: some View {
        Form {
            Section("Mac 服务") {
                TextField("HTTPS 接口地址", text: $endpoint).accessibilityIdentifier("watch-signature-endpoint")
                SecureField("服务认证值", text: $key).accessibilityIdentifier("watch-signature-key")
            }
            Text("创建指标与锻炼两个 Watch 独立任务。认证只保存在手表钥匙串；创建后分别授权并启用。").font(.footnote)
            Button("创建同步任务") {
                saving = true
                Task {
                    defer { saving = false }
                    do { try await store.installHealthSignature(endpoint: endpoint, key: key); key = ""; dismiss() }
                    catch { self.error = error.localizedDescription }
                }
            }.disabled(saving || endpoint.isEmpty || key.isEmpty).accessibilityIdentifier("watch-create-signature")
            if let error { Text(error).foregroundStyle(.red).font(.footnote) }
        }.navigationTitle("健康签名设置")
            .onAppear { if endpoint.isEmpty { endpoint = store.tasks.first?.destination.url ?? "" } }
    }
}

struct WatchWorkoutView: View {
    let store: WatchStore
    @Bindable var model: WatchWorkoutController
    @State private var activity = HKWorkoutActivityType.functionalStrengthTraining
    @State private var confirmingStop = false
    private var task: AutomationConfig? {
        store.tasks.first { $0.enabled && $0.data.selections.contains { $0.id == "HKWorkoutType" } && $0.export.format == "healthrelay.v1" }
    }
    var body: some View {
        List {
            Section("运动记录") {
                if model.running || model.finishing || model.needsFinish {
                    Text(model.finishing ? "正在保存" : model.paused ? "已暂停" : model.running ? "运动中" : "运动待保存").font(.headline)
                    TimelineView(.periodic(from: Date(), by: 1)) { context in
                        let seconds = Int(max(0, model.elapsed(at: context.date)))
                        Text(String(format: "%02d:%02d", seconds/60, seconds%60)).font(.title2.monospacedDigit())
                    }
                    if let heart = model.heartRate { Text("心率 \(Int(heart.rounded())) 次/分").privacySensitive() }
                    else { Text("等待心率采样").font(.footnote) }
                    if model.running {
                        Button(model.paused ? "继续运动" : "暂停") { model.togglePause() }.disabled(model.finishing)
                        Button("结束并保存", role: .destructive) { confirmingStop = true }.disabled(model.finishing)
                    } else if model.needsFinish {
                        Button("重试结束并保存") { model.stop() }.disabled(model.finishing)
                    }
                } else {
                    Picker("运动类型", selection: $activity) {
                        Text("力量训练").tag(HKWorkoutActivityType.functionalStrengthTraining)
                        Text("室内步行").tag(HKWorkoutActivityType.walking)
                        Text("室内跑步").tag(HKWorkoutActivityType.running)
                        Text("室内骑行").tag(HKWorkoutActivityType.cycling)
                    }
                    Button("开始运动") { if let task { Task { await model.start(task: task, activity: activity) } } }
                        .disabled(task == nil || model.starting || model.hasUnsentRecords).accessibilityIdentifier("watch-start-workout")
                    if task == nil { Text("请先配置并授权启用 Watch 锻炼同步任务。").font(.footnote) }
                }
            }
            Section("服务同步") {
                Text(model.status).font(.footnote)
                if let time = model.lastConfirmedAt { Text("服务确认：") + Text(time, style: .time) }
                Button("重试待传记录") { Task { await model.retryUploads(manual: true) } }
                Text("运动期间每分钟尝试发送摘要；网络或系统可能延后。收到回执后才确认上传。").font(.caption2)
            }
            Text("此功能会记录一次真实运动并保存到 Apple 健康；结束后回到系统安排的日常同步。").font(.caption2)
        }.navigationTitle("运动与同步")
            .confirmationDialog("结束并保存本次运动？", isPresented: $confirmingStop) {
                Button("结束并保存") { model.stop() }
            }
    }
}
