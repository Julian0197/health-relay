import Foundation

public struct BatchIdentity: Codable, Equatable, Sendable {
    public var taskID: UUID
    public var batchID: String
    public var fingerprint: String
    public init(taskID: UUID, batchID: String, fingerprint: String) {
        self.taskID = taskID; self.batchID = batchID; self.fingerprint = fingerprint
    }
    public func matches(_ pending: PendingUpload) -> Bool {
        batchID == pending.batchID && fingerprint == pending.configurationFingerprint
    }
}

extension SyncJournal {
    /// False means stale/duplicate callback. It must not change any journal state.
    @discardableResult public func confirm(_ identity: BatchIdentity, task: AutomationConfig, status: Int, data: Data, now: Date = Date()) throws -> Bool {
        guard identity.taskID == task.id, identity.fingerprint == (try SyncIdentity.fingerprint(task)) else { return false }
        var state = try load(identity.taskID)
        guard let pending = state.pending, identity.matches(pending) else { return false }
        try HTTPAcknowledgement.validate(status: status, data: data, batchID: pending.batchID, count: pending.recordCount, mode: task.destination.acknowledgement)
        state.checkpoints[pending.checkpointKey] = pending.checkpoint
        state.pending = nil; state.lastConfirmedAt = now
        state.logs.insert(RunLog(state: .succeeded, message: "后台已确认 \(pending.recordCount) 条", records: pending.recordCount, batches: 1, httpStatus: status), at: 0)
        state.logs = Array(state.logs.prefix(30))
        try save(state, for: identity.taskID)
        return true
    }
    @discardableResult public func recordFailure(_ identity: BatchIdentity, failure: UploadFailure, now: Date = Date()) throws -> Bool {
        var state = try load(identity.taskID)
        guard var pending = state.pending, identity.matches(pending) else { return false }
        pending.attempts += 1
        pending.automaticRetry = failure.retryable
        let delay = failure.retryAfter ?? min(3600, 30 * pow(2, Double(min(7, pending.attempts - 1))))
        pending.nextAttempt = now.addingTimeInterval(max(30, delay))
        state.pending = pending
        state.logs.insert(RunLog(state: .failed, message: failure.message, httpStatus: failure.status), at: 0)
        state.logs = Array(state.logs.prefix(30))
        try save(state, for: identity.taskID)
        return true
    }
}

extension BatchIdentity {
    public static func decodeDescription(_ text: String?) -> Self? {
        text.flatMap { try? JSONDecoder().decode(Self.self, from: Data($0.utf8)) }
    }
}
public enum BackgroundUploadPolicy {
    public static func redirected(original: URL?, current: URL?, response: URL?) -> Bool {
        guard let original else { return false }
        return current.map { $0 != original } == true || response.map { $0 != original } == true
    }
}

extension SyncJournal {
    /// Call only after the transport has finished/cancelled this exact batch.
    @discardableResult public func discard(_ identity: BatchIdentity) throws -> Bool {
        var state = try load(identity.taskID)
        guard let pending = state.pending, identity.matches(pending) else { return false }
        state.pending = nil
        state.logs.insert(RunLog(state: .queued, message: "已取消未确认批次；未推进游标，下次从已确认位置重新读取"), at: 0)
        state.logs = Array(state.logs.prefix(30))
        try save(state, for: identity.taskID)
        return true
    }
}
