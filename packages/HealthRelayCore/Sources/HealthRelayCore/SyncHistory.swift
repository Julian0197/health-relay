import Foundation

public struct SyncHistoryContext: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable { case daily, backfill, workout, legacy }
    public var taskID: UUID
    public var journalID: UUID
    public var taskName: String
    public var device: ExecutionDevice
    public var kind: Kind
    public var destinationHost: String?
    public init(taskID: UUID, journalID: UUID? = nil, taskName: String, device: ExecutionDevice, kind: Kind, destinationHost: String? = nil) {
        self.taskID = taskID; self.journalID = journalID ?? taskID
        self.taskName = String(taskName.prefix(200)); self.device = device; self.kind = kind
        self.destinationHost = destinationHost
    }
    public init(task: AutomationConfig, journalID: UUID? = nil, kind: Kind = .daily, originTaskID: UUID? = nil) {
        self.init(taskID: originTaskID ?? task.id, journalID: journalID ?? task.id, taskName: task.name,
                  device: task.device, kind: kind, destinationHost: URL(string: task.destination.url)?.host)
    }
}

public struct SyncHistorySummary: Codable, Equatable, Sendable {
    public struct Metric: Codable, Equatable, Identifiable, Sendable {
        public var id: String { typeIdentifier }
        public var typeIdentifier: String
        public var title: String
        public var records: Int
        public var deletions: Int
        public var measuredFrom: Date?
        public var measuredTo: Date?
        public var latestValue: Double?
        public var unit: String?
        public var detail: String?
    }
    public var recordCount: Int
    public var deletions: Int
    public var measuredFrom: Date?
    public var measuredTo: Date?
    public var metrics: [Metric]
    public init(recordCount: Int = 0) {
        self.recordCount = recordCount; deletions = 0; metrics = []
    }
    public init(records: [HealthRecord]) {
        let dated = records.map { record in
            let start = AutomationConfig.parseDate(record.start)
            return (record: record, start: start, end: record.end == nil ? start : AutomationConfig.parseDate(record.end))
        }
        recordCount = records.count; deletions = records.filter { $0.op == .delete }.count
        measuredFrom = dated.compactMap(\.start).min(); measuredTo = dated.compactMap(\.end).max()
        metrics = Dictionary(grouping: dated, by: { $0.record.typeIdentifier }).map { type, rows in
            let latest = rows.filter { $0.record.op == .upsert }
                .max { ($0.end ?? .distantPast) < ($1.end ?? .distantPast) }?.record
            var value = latest?.payload?["value"]?.historyNumber
            var unit = latest?.payload?["unit"]?.historyString
            var detail: String?
            if type == "HKCategoryTypeIdentifierSleepAnalysis" {
                let labels = [0: "卧床", 1: "睡眠（未分期）", 2: "清醒", 3: "核心睡眠", 4: "深度睡眠", 5: "快速眼动睡眠"]
                detail = value.map { "最新阶段：" + (labels[Int($0)] ?? "未知阶段") }; value = nil; unit = nil
            } else if type == "HKWorkoutType" {
                value = latest?.payload?["durationSeconds"]?.historyNumber; unit = "s"
                let activity = latest?.payload?["activityType"]?.historyNumber
                let name = activity.flatMap { HEAWorkoutEncoder.activityNames[Int($0)] } ?? "运动"
                detail = "\(name) · 该次运动累计时长"
                if case .object(let live)? = latest?.payload?["live"], case .object(let heart)? = live["heartRate"],
                   let heartRate = heart["value"]?.historyNumber, heartRate.isFinite {
                    detail! += " · 心率 \(Int(heartRate.rounded())) 次/分"
                }
            } else if type == "HKQuantityTypeIdentifierStepCount" {
                detail = "本批步数记录的最新值，非今日总步数"
            }
            return Metric(typeIdentifier: type, title: MetricCatalog.bundled.metric(type)?.title ?? (type == "HKWorkoutType" ? "锻炼" : type),
                          records: rows.count, deletions: rows.filter { $0.record.op == .delete }.count,
                          measuredFrom: rows.compactMap(\.start).min(), measuredTo: rows.compactMap(\.end).max(),
                          latestValue: value.flatMap { $0.isFinite ? $0 : nil }, unit: unit, detail: detail)
        }.sorted { $0.typeIdentifier < $1.typeIdentifier }
    }
}

private extension JSONValue {
    var historyNumber: Double? { if case .number(let value) = self { value } else { nil } }
    var historyString: String? { if case .string(let value) = self { value } else { nil } }
}

public enum SyncHistoryState: String, Codable, CaseIterable, Sendable {
    case queued, sending, succeeded, failed, cancelled
    public var title: String {
        switch self { case .queued: "待上传"; case .sending: "传输中，待确认"; case .succeeded: "同步成功"; case .failed: "同步失败"; case .cancelled: "已取消" }
    }
}
public enum SyncHistoryFilter: String, CaseIterable, Sendable { case all, success, attention }
public struct SyncHistoryCursor: Sendable { public var date: Date; public var id: String }
public struct SyncHistoryPage: Sendable { public var entries: [SyncHistoryEntry]; public var nextCursor: SyncHistoryCursor? }
public struct SyncHistoryEntry: Codable, Identifiable, Equatable, Sendable {
    public var id: String
    public var context: SyncHistoryContext
    public var batchID: String?
    public var state: SyncHistoryState
    public var queuedAt: Date?
    public var updatedAt: Date
    public var confirmedAt: Date?
    public var summary: SyncHistorySummary
    public var message: String?
    public var httpStatus: Int?
    public var attempts: Int
    public var legacy: Bool
}
public struct SyncHistoryActivity: Codable, Identifiable, Equatable, Sendable {
    public var id: String
    public var date: Date
    public var state: SyncHistoryState
    public var attemptID: String?
    public var message: String?
    public var httpStatus: Int?
}
public struct SyncHistoryDetail: Sendable { public var entry: SyncHistoryEntry; public var events: [SyncHistoryActivity] }
public struct SyncHistoryEvent: Codable, Identifiable, Equatable, Sendable {
    public var id: String
    public var entryID: String
    public var context: SyncHistoryContext
    public var batchID: String?
    public var date: Date
    public var state: SyncHistoryState
    public var summary: SyncHistorySummary?
    public var queuedAt: Date?
    public var attemptID: String?
    public var message: String?
    public var httpStatus: Int?
    public var legacy: Bool
    public var confirmationTimeKnown: Bool?
    public init(id: String = UUID().uuidString, entryID: String, context: SyncHistoryContext, batchID: String? = nil,
                date: Date, state: SyncHistoryState, summary: SyncHistorySummary? = nil, queuedAt: Date? = nil,
                attemptID: String? = nil, message: String? = nil, httpStatus: Int? = nil, legacy: Bool = false, confirmationTimeKnown: Bool = true) {
        self.id = id; self.entryID = entryID; self.context = context; self.batchID = batchID
        self.date = date; self.state = state; self.summary = summary; self.queuedAt = queuedAt
        self.attemptID = attemptID; self.message = message.map { String($0.prefix(512)) }
        self.httpStatus = httpStatus; self.legacy = legacy
        self.confirmationTimeKnown = confirmationTimeKnown
    }
}
public struct SyncHistoryMetadata: Codable, Sendable {
    public var context: SyncHistoryContext
    public var summary: SyncHistorySummary
    public var queuedAt: Date
    public var attemptID: String?
    public var attemptStartedAt: Date?
    public var lastCompletionID: String?
    public var legacy: Bool?
    public init(context: SyncHistoryContext, summary: SyncHistorySummary, queuedAt: Date) {
        self.context = context; self.summary = summary; self.queuedAt = queuedAt
    }
}
