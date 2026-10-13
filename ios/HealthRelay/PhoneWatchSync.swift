import Foundation
import Observation
import WatchConnectivity
import HealthRelayCore

@MainActor @Observable final class PhoneWatchSync: NSObject, WCSessionDelegate {
    private(set) var status = "尚未同步 Watch 配置"
    private var ledger = WatchOwnershipLedger()
    var possibleWatchIDs: Set<UUID> { ledger.possibleWatchIDs }
    private var ownershipStateReadable = true
    var canExecutePhoneTasks: Bool { ownershipStateReadable }
    private let defaults = UserDefaults.standard
    override init() {
        super.init()
        if let data = defaults.data(forKey: "WatchSync.ledger") {
            if let restored = try? JSONDecoder().decode(WatchOwnershipLedger.self, from: data) { ledger = restored }
            else { status = "Watch 归属状态损坏，请重新同步并等待确认"; ownershipStateReadable = false }
        }
        status = defaults.string(forKey: "WatchSync.status") ?? status
        if WCSession.isSupported() { WCSession.default.delegate = self; WCSession.default.activate() }
    }
    func sync(tasks: [AutomationConfig]) throws {
        let session = WCSession.default
        guard session.activationState == .activated, session.isPaired, session.isWatchAppInstalled else { throw ConfigurationError("请先安装并打开配对 Watch 上的 HealthRelay") }
        var snapshot = try WatchConfigurationSnapshot(tasks: tasks)
        snapshot.generation = max(snapshot.generation, Int64(defaults.double(forKey: "WatchSync.generation")) + 1)
        defaults.set(snapshot.generation, forKey: "WatchSync.generation")
        let data = try JSONEncoder().encode(snapshot)
        ledger.queued(id: snapshot.id, taskIDs: Set(tasks.map(\.id)))
        status = "已排队，等待 Watch 收到并验证（\(tasks.count) 个任务）"
        persist()
        session.transferUserInfo(["snapshot": data, "snapshotID": snapshot.id.uuidString])
    }
    private func persist() {
        if let data = try? JSONEncoder().encode(ledger) { defaults.set(data, forKey: "WatchSync.ledger") }
        defaults.set(status, forKey: "WatchSync.status")
    }
    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: (any Error)?) {}
    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}
    nonisolated func sessionDidDeactivate(_ session: WCSession) { session.activate() }
    nonisolated func session(_ session: WCSession, didFinish userInfoTransfer: WCSessionUserInfoTransfer, error: (any Error)?) {
        guard error != nil, let text = userInfoTransfer.userInfo["snapshotID"] as? String, let id = UUID(uuidString: text) else { return }
        Task { @MainActor in
            guard self.ledger.pendingID == id else { return }
            self.status = "Watch 配置传输失败，请重新同步；设备归属仍受保护"
            self.persist()
        }
    }
    nonisolated func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any]) {
        guard let text = userInfo["snapshotID"] as? String, let id = UUID(uuidString: text), let accepted = userInfo["accepted"] as? Bool else { return }
        let reason = userInfo["reason"] as? String
        Task { @MainActor in
            guard self.ledger.received(id: id, accepted: accepted) else { return }
            if accepted {
                self.status = "Watch 已收到并保存；请在 Watch 填写认证、授权并启用"
                self.ownershipStateReadable = true
            } else { self.status = "Watch 拒绝同步：" + (reason ?? "配置验证失败") }
            self.persist()
        }
    }
}
