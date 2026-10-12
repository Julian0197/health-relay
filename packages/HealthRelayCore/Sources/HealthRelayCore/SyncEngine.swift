import Foundation

public struct ReadPage: Sendable {
    public var records: [HealthRecord]
    public var anchor: Data?
    public var hasMore: Bool
    public init(records: [HealthRecord], anchor: Data?, hasMore: Bool) { self.records = records; self.anchor = anchor; self.hasMore = hasMore }
}
@MainActor public protocol HealthDataReader {
    func read(task: AutomationConfig, selection: MetricSelection, checkpoint: TypeCheckpoint, limit: Int) async throws -> ReadPage
}
@MainActor public final class SyncEngine {
    private let reader: any HealthDataReader
    private let sender: any UploadSender
    public let journal: SyncJournal
    private var running: Set<UUID> = []
    public init(reader: any HealthDataReader, sender: any UploadSender, journal: SyncJournal) {
        self.reader = reader; self.sender = sender; self.journal = journal
    }
    public func isRunning(_ id: UUID) -> Bool { running.contains(id) }
    public func run(_ task: AutomationConfig, automatic: Bool = false, timeBudget: TimeInterval = 25) async -> RunLog {
        guard running.insert(task.id).inserted else { return RunLog(state: .running, message: "任务正在运行") }
        defer { running.remove(task.id) }
        var state: SyncState
        do { state = try journal.load(task.id) }
        catch { return RunLog(state: .failed, message: "同步状态无法读取，已停止以保护原文件") }
        var count = 0, batches = 0, status: Int?
        let started = Date()
        do {
            let issues = task.validationIssues(systemMajorVersion: 27) + task.executionIssues
            guard issues.isEmpty else { throw ConfigurationError(issues.joined(separator: "；")) }
            let fingerprint = try SyncIdentity.fingerprint(task)
            if let pending = state.pending {
                guard pending.configurationFingerprint == fingerprint else { throw ConfigurationError("有待上传批次，请恢复原配置并重试后再修改接口或数据规则") }
                if automatic && (!pending.automaticRetry || (pending.nextAttempt ?? .distantPast) > Date()) {
                    return RunLog(state: .queued, message: "批次等待重试")
                }
                try Task.checkCancellation()
                status = try await sender.send(pending, destination: task.destination)
                state.checkpoints[pending.checkpointKey] = pending.checkpoint
                state.pending = nil
                state.lastConfirmedAt = Date()
                try journal.save(state, for: task.id)
                count += pending.recordCount; batches += 1
            }
            state.lastAttempt = started
            try journal.save(state, for: task.id)
            var activeKeys = Set<String>()
            for selection in task.data.selections {
                let (key, initial) = try SyncIdentity.key(task, selection: selection, now: started)
                activeKeys.insert(key)
                var checkpoint = state.checkpoints[key] ?? initial
                while true {
                    try Task.checkCancellation()
                    var limit = task.execution.batchMaxRecords
                    var page: ReadPage
                    var upload: PendingUpload?
                    while true {
                        page = try await reader.read(task: task, selection: selection, checkpoint: checkpoint, limit: limit)
                        var next = checkpoint; next.anchor = page.anchor
                        if page.records.isEmpty { upload = nil; break }
                        let batch = UploadBatch(task: task, records: page.records)
                        let encoded = try BatchEncoder.encode(batch, format: task.export.format, timeZone: task.export.timeZone)
                        if encoded.body.count <= task.execution.batchMaxBytes {
                            upload = PendingUpload(batchID: batch.batchId, body: encoded.body, contentType: encoded.contentType, recordCount: page.records.count, checkpointKey: key, checkpoint: next, configurationFingerprint: fingerprint)
                            break
                        }
                        guard limit > 1 else { throw ConfigurationError("单条记录超过批次大小上限，请提高每批 KiB 上限") }
                        limit = max(1, limit / 2)
                    }
                    if let upload {
                        state.pending = upload
                        try journal.save(state, for: task.id)
                        status = try await sender.send(upload, destination: task.destination)
                        state.pending = nil
                        state.lastConfirmedAt = Date()
                        count += upload.recordCount; batches += 1
                    }
                    checkpoint.anchor = page.anchor
                    state.checkpoints[key] = checkpoint
                    try journal.save(state, for: task.id)
                    if !page.hasMore { break }
                    if Date().timeIntervalSince(started) >= timeBudget {
                        return try finish(RunLog(state: .queued, message: "已确认 \(count) 条，剩余数据将在下次执行继续", records: count, batches: batches, httpStatus: status), state: &state, id: task.id)
                    }
                }
            }
            // Retain only the current query generation; fixed windows must not grow indefinitely.
            state.checkpoints = state.checkpoints.filter { activeKeys.contains($0.key) }
            return try finish(RunLog(state: count == 0 ? .noData : .succeeded, message: count == 0 ? (state.lastConfirmedAt == nil ? "没有可读取的新记录；请检查健康读取权限或数据是否已同步" : "没有可读取的新记录，无需重复上传") : "已上传并确认 \(count) 条 · \(batches) 批", records: count, batches: batches, httpStatus: status), state: &state, id: task.id)
        } catch {
            if state.pending != nil {
                state.pending!.attempts += 1
                let failure = error as? UploadFailure
                state.pending!.automaticRetry = failure?.retryable ?? (error is ConfigurationError ? false : true)
                let delay = failure?.retryAfter ?? min(3600, 30 * pow(2, Double(min(7, state.pending!.attempts - 1))))
                state.pending!.nextAttempt = Date().addingTimeInterval(delay)
            }
            let log = RunLog(state: .failed, message: error is CancellationError ? "执行已中断，未确认批次已保留" : error.localizedDescription, records: count, batches: batches, httpStatus: (error as? UploadFailure)?.status)
            do { return try finish(log, state: &state, id: task.id) }
            catch { return RunLog(state: .failed, message: "同步状态写入失败；未确认数据会重新读取或重试") }
        }
    }
    private func finish(_ log: RunLog, state: inout SyncState, id: UUID) throws -> RunLog {
        state.logs.insert(log, at: 0); state.logs = Array(state.logs.prefix(30))
        try journal.save(state, for: id)
        return log
    }
}
