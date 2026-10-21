import Foundation
import Observation

@MainActor @Observable public final class SyncHistoryBrowser {
    public let store: SyncHistoryStore
    public let taskID: UUID?
    public var filter: SyncHistoryFilter = .all
    public private(set) var entries: [SyncHistoryEntry] = []
    public private(set) var nextCursor: SyncHistoryCursor?
    public private(set) var loading = false
    public private(set) var error: String?
    private var generation = 0
    public init(store: SyncHistoryStore, taskID: UUID? = nil) { self.store = store; self.taskID = taskID }
    public func reload() async {
        generation += 1
        await fetch(cursor: nil, generation: generation)
    }
    public func loadMore() async {
        guard !loading, let nextCursor else { return }
        await fetch(cursor: nextCursor, generation: generation)
    }
    private func fetch(cursor: SyncHistoryCursor?, generation requested: Int) async {
        loading = true; error = nil
        let store = store, taskID = taskID, filter = filter
        let result = await Task.detached(priority: .userInitiated) {
            Result { try store.page(taskID: taskID, filter: filter, cursor: cursor) }
        }.value
        guard requested == generation else { return }
        loading = false
        switch result {
        case .success(let page):
            if cursor == nil { entries = page.entries }
            else {
                let existing = Set(entries.map(\.id))
                entries += page.entries.filter { !existing.contains($0.id) }
            }
            nextCursor = page.nextCursor
        case .failure(let failure):
            if (failure as? CocoaError)?.code == .fileReadNoPermission {
                error = "设备锁定，请解锁后查看同步历史"
            } else { error = "无法读取同步历史，原文件已保留。请解锁设备后重试。" }
        }
    }
}

public extension Notification.Name {
    static let syncHistoryChanged = Notification.Name("HealthRelay.syncHistoryChanged")
}
