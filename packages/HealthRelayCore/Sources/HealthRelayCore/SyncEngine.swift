import Foundation

public struct ReadPage: Sendable {
    public var records: [HealthRecord]
    public var anchor: Data?
    public var hasMore: Bool
    public var checkpoint: TypeCheckpoint?
    public init(records: [HealthRecord], anchor: Data?, hasMore: Bool, checkpoint: TypeCheckpoint? = nil) { self.records = records; self.anchor = anchor; self.hasMore = hasMore; self.checkpoint = checkpoint }
}
@MainActor public protocol HealthDataReader {
    func read(task: AutomationConfig, selection: MetricSelection, checkpoint: TypeCheckpoint, limit: Int) async throws -> ReadPage
}
@MainActor public final class SyncEngine {
    private let reader: any HealthDataReader
    private let sender: any UploadSender
    public let journal: SyncJournal
    private var running: Set<UUID> = []
    private let now: () -> Date
    public init(reader: any HealthDataReader, sender: any UploadSender, journal: SyncJournal, now: @escaping () -> Date = Date.init) {
        self.reader = reader; self.sender = sender; self.journal = journal; self.now = now
    }
    public func isRunning(_ id: UUID) -> Bool { running.contains(id) }
    public func run(_ task: AutomationConfig, automatic: Bool = false, timeBudget: TimeInterval = 25, storageID: UUID? = nil, trigger: String = "manual", prepareOnly: Bool = false) async -> RunLog {
        let stateID = storageID ?? task.id
        guard running.insert(stateID).inserted else { return RunLog(state: .running, message: "任务正在运行") }
        defer { running.remove(stateID) }
        var state: SyncState
        do { state = try journal.load(stateID) }
        catch { return RunLog(state: .failed, message: "同步状态无法读取，已停止以保护原文件") }
        var count = 0, batches = 0, status: Int?
        let started = now()
        var metricCounts: [String: Int] = [:], omitted = 0
        func result(_ state: RunLog.State, _ message: String, status: Int? = nil) -> RunLog {
            var log = RunLog(state: state, message: message, records: count, batches: batches, httpStatus: status)
            log.trigger = trigger; log.durationSeconds = max(0, now().timeIntervalSince(started)); log.metricCounts = metricCounts; log.omittedDeletions = omitted
            return log
        }
        func exhausted() -> Bool { Task.isCancelled || now().timeIntervalSince(started) >= timeBudget }
        do {
            let issues = task.validationIssues(systemMajorVersion: 27, device: task.device) + task.executionIssues
            guard issues.isEmpty else { throw ConfigurationError(issues.joined(separator: "；")) }
            let fingerprint = try SyncIdentity.fingerprint(task)
            state.lastAttempt = started
            try journal.save(state, for: stateID)
            if let pending = state.pending {
                guard pending.configurationFingerprint == fingerprint else { throw ConfigurationError("有待上传批次，请恢复原配置并重试后再修改接口或数据规则") }
                if automatic && (!pending.automaticRetry || (pending.nextAttempt ?? .distantPast) > Date()) {
                    return RunLog(state: .queued, message: "批次等待重试")
                }
                if prepareOnly || exhausted() { return try finish(result(.queued, "批次已保存，等待上传"), state: &state, id: stateID) }
                try Task.checkCancellation()
                status = try await sender.send(pending, destination: task.destination)
                state.checkpoints[pending.checkpointKey] = pending.checkpoint
                state.pending = nil
                state.lastConfirmedAt = Date()
                try journal.save(state, for: stateID)
                count += pending.recordCount; batches += 1
            }
            if state.cycleFingerprint != fingerprint || state.cycleStartedAt == nil {
                state.cycleStartedAt = started; state.cycleFingerprint = fingerprint; state.nextSelectionID = nil
            }
            let queryDate = state.cycleStartedAt ?? started
            state.lastAttempt = started
            try journal.save(state, for: stateID)
            let keys = try task.data.selections.map { try SyncIdentity.key(task, selection: $0, now: queryDate).0 }
            let activeKeys = Set(keys)
            let offset = state.nextSelectionID.flatMap { id in task.data.selections.firstIndex(where: { $0.id == id }) } ?? 0
            for selection in task.data.selections.dropFirst(offset) {
                state.nextSelectionID = selection.id
                if exhausted() { return try finish(result(.queued, "已保存进度，等待继续", status: status), state: &state, id: stateID) }
                let (key, initial) = try SyncIdentity.key(task, selection: selection, now: queryDate)
                var checkpoint = state.checkpoints[key] ?? initial
                while true {
                    try Task.checkCancellation()
                    if exhausted() { return try finish(result(.queued, "已保存进度，等待继续", status: status), state: &state, id: stateID) }
                    var limit = task.execution.batchMaxRecords
                    var page: ReadPage
                    var upload: PendingUpload?
                    var pageOmitted = 0
                    while true {
                        page = try await reader.read(task: task, selection: selection, checkpoint: checkpoint, limit: limit)
                        var next = page.checkpoint ?? checkpoint; next.anchor = page.anchor
                        var records = page.records
                        if task.export.format.hasPrefix("hea."), task.export.deletionPolicy == .omit {
                            pageOmitted = records.filter { $0.op == .delete }.count
                            records.removeAll { $0.op == .delete }
                        }
                        if records.isEmpty { upload = nil; break }
                        let batch = UploadBatch(task: task, records: records)
                        let encoded = try BatchEncoder.encode(batch, format: task.export.format, timeZone: task.export.timeZone, heaDataType: task.export.heaDataType)
                        if encoded.body.count <= task.execution.batchMaxBytes {
                            upload = PendingUpload(batchID: batch.batchId, body: encoded.body, contentType: encoded.contentType, recordCount: records.count, checkpointKey: key, checkpoint: next, configurationFingerprint: fingerprint)
                            if task.export.format.hasPrefix("hea.") { upload?.headers = HEARequestMetadata.headers(task: task, batchID: batch.batchId) }
                            break
                        }
                        guard limit > 1 && records.count > 1 else {
                            let sizeKiB = (encoded.body.count + 1023) / 1024
                            throw ConfigurationError("单条完整记录约 \(sizeKiB) KiB，超过批次上限；请提高每批 KiB 上限。运动可关闭路线或关联指标后重试，当前读取游标未提交")
                        }
                        limit = max(1, limit / 2)
                    }
                    omitted += pageOmitted
                    if let upload {
                        state.pending = upload
                        try journal.save(state, for: stateID)
                        if prepareOnly || exhausted() { return try finish(result(.queued, "批次已保存，等待上传", status: status), state: &state, id: stateID) }
                        status = try await sender.send(upload, destination: task.destination)
                        state.pending = nil
                        state.lastConfirmedAt = Date()
                        count += upload.recordCount; batches += 1
                        metricCounts[selection.id, default: 0] += upload.recordCount
                    }
                    checkpoint = page.checkpoint ?? checkpoint
                    checkpoint.anchor = page.anchor
                    state.checkpoints[key] = checkpoint
                    try journal.save(state, for: stateID)
                    if !page.hasMore {
                        if let index = task.data.selections.firstIndex(where: { $0.id == selection.id }), index + 1 < task.data.selections.count { state.nextSelectionID = task.data.selections[index + 1].id }
                        else { state.nextSelectionID = nil }
                        try journal.save(state, for: stateID)
                        break
                    }
                    if exhausted() {
                        return try finish(result(.queued, "已确认 \(count) 条，剩余数据将在下次执行继续", status: status), state: &state, id: stateID)
                    }
                }
            }
            // Retain only the current query generation; fixed windows must not grow indefinitely.
            state.checkpoints = state.checkpoints.filter { activeKeys.contains($0.key) }
            state.nextSelectionID = nil; state.cycleStartedAt = nil; state.cycleFingerprint = nil
            return try finish(result(count == 0 ? .noData : .succeeded, count == 0 ? (state.lastConfirmedAt == nil ? "没有可读取的新记录；请检查健康读取权限或数据是否已同步" : "没有可读取的新记录，无需重复上传") : "已上传并确认 \(count) 条 · \(batches) 批", status: status), state: &state, id: stateID)
        } catch {
            if state.pending != nil {
                state.pending!.attempts += 1
                let failure = error as? UploadFailure
                state.pending!.automaticRetry = failure?.retryable ?? (error is ConfigurationError ? false : true)
                let delay = failure?.retryAfter ?? min(3600, 30 * pow(2, Double(min(7, state.pending!.attempts - 1))))
                state.pending!.nextAttempt = Date().addingTimeInterval(delay)
            }
            let log = result(.failed, error is CancellationError ? "执行已中断，未确认批次已保留" : error.localizedDescription, status: (error as? UploadFailure)?.status)
            do { return try finish(log, state: &state, id: stateID) }
            catch { return RunLog(state: .failed, message: "同步状态写入失败；未确认数据会重新读取或重试") }
        }
    }
    private func finish(_ log: RunLog, state: inout SyncState, id: UUID) throws -> RunLog {
        state.logs.insert(log, at: 0); state.logs = Array(state.logs.prefix(30))
        try journal.save(state, for: id)
        return log
    }
}
