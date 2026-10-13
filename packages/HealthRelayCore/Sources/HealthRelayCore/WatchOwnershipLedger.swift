import Foundation

/// Keep phone execution blocked until the latest full snapshot confirms Watch ownership.
public struct WatchOwnershipLedger: Codable, Sendable {
    public private(set) var possibleWatchIDs: Set<UUID> = []
    public private(set) var pendingID: UUID?
    private var pendingIDs: Set<UUID> = []
    public init() {}
    public mutating func queued(id: UUID, taskIDs: Set<UUID>) {
        pendingID = id; pendingIDs = taskIDs; possibleWatchIDs.formUnion(taskIDs)
    }
    @discardableResult public mutating func received(id: UUID, accepted: Bool) -> Bool {
        guard pendingID == id else { return false }
        if accepted { possibleWatchIDs = pendingIDs; pendingID = nil }
        return true
    }
}
