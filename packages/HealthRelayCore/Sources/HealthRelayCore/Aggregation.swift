import Foundation
import CryptoKit

public struct AggregateWindow: Codable, Equatable, Sendable {
    public var start: Date
    public var end: Date
    public var id: String { "window:\(HealthTimestamp.string(start)):\(HealthTimestamp.string(end))" }
    public static func containing(_ date: Date, grouping: ExportSettings.Grouping, timeZone: String, sleep: Bool = false) throws -> Self {
        guard let zone = TimeZone(identifier: timeZone) else { throw ConfigurationError("汇总时区无效") }
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = zone; calendar.firstWeekday = 2; calendar.minimumDaysInFirstWeek = 4
        if sleep {
            let noon = calendar.date(bySettingHour: 12, minute: 0, second: 0, of: date)!
            let start = date < noon ? calendar.date(byAdding: .day, value: -1, to: noon)! : noon
            return Self(start: start, end: calendar.date(byAdding: .day, value: 1, to: start)!)
        }
        let component: Calendar.Component
        switch grouping {
        case .seconds: component = .second
        case .minutes: component = .minute
        case .hours: component = .hour
        case .days: component = .day
        case .weeks: component = .weekOfYear
        case .months: component = .month
        case .years: component = .year
        case .none: throw ConfigurationError("汇总必须指定时间分组")
        }
        guard let interval = calendar.dateInterval(of: component, for: date) else { throw ConfigurationError("无法确定汇总窗口") }
        return Self(start: interval.start, end: interval.end)
    }
}

public struct AggregateState: Codable, Sendable {
    public var sampleWindows: [String: DateInterval] = [:]
    public var dirty: [DateInterval] = []
    public var hashes: [String: String] = [:]
    public var moreChanges = false
    public init() {}
    mutating func mark(_ range: DateInterval) {
        dirty.append(range)
        var merged: [DateInterval] = []
        for range in dirty.sorted(by: { $0.start < $1.start }) {
            if let last = merged.last, range.start <= last.end {
                merged[merged.count - 1] = DateInterval(start: last.start, end: max(last.end, range.end))
            } else { merged.append(range) }
        }
        dirty = merged
    }
    mutating func trim() {
        // Keep only identity/time metadata, never a second health history. A miss triggers a sweep.
        if sampleWindows.count > 20_000 {
            let keep = sampleWindows.sorted { $0.value.end == $1.value.end ? $0.key > $1.key : $0.value.end > $1.value.end }.prefix(20_000)
            sampleWindows = Dictionary(uniqueKeysWithValues: keep.map { ($0.key, $0.value) })
        }
        if hashes.count > 4096 { hashes = Dictionary(uniqueKeysWithValues: hashes.sorted { $0.key > $1.key }.prefix(4096).map { ($0.key, $0.value) }) }
    }
}

@MainActor public protocol AggregateSource {
    func readChanges(task: AutomationConfig, selection: MetricSelection, checkpoint: TypeCheckpoint, limit: Int) async throws -> ReadPage
    func snapshot(task: AutomationConfig, selection: MetricSelection, window: AggregateWindow) async throws -> [String: JSONValue]?
}

@MainActor public final class AggregationReader: HealthDataReader {
    private let source: any AggregateSource
    private let now: () -> Date
    public init(source: any AggregateSource, now: @escaping () -> Date = Date.init) { self.source = source; self.now = now }
    public func read(task: AutomationConfig, selection: MetricSelection, checkpoint: TypeCheckpoint, limit: Int) async throws -> ReadPage {
        var next = checkpoint
        var state = checkpoint.aggregate ?? AggregateState()
        let sleep = selection.id == "HKCategoryTypeIdentifierSleepAnalysis"
        func window(_ date: Date) throws -> AggregateWindow {
            try AggregateWindow.containing(date, grouping: task.export.grouping, timeZone: task.export.timeZone, sleep: sleep)
        }
        let lower = try window(checkpoint.start).start
        let upper = try checkpoint.end.map { try window($0.addingTimeInterval(-0.001)).end }
        func clipped(_ range: DateInterval) -> DateInterval? {
            let start = max(range.start, lower), end = min(range.end, upper ?? range.end)
            return start < end ? DateInterval(start: start, end: end) : nil
        }
        if state.dirty.isEmpty {
            let changes = try await source.readChanges(task: task, selection: selection, checkpoint: checkpoint, limit: min(limit, 500))
            next.anchor = changes.anchor; state.moreChanges = changes.hasMore
            for record in changes.records {
                if record.op == .delete {
                    if let old = state.sampleWindows.removeValue(forKey: record.recordId) { state.mark(old) }
                    else {
                        // An evicted/unknown UUID may belong to any old window. Sweep lazily, not in one huge query.
                        let start = try window(checkpoint.start).start
                        let end = try window(max(checkpoint.start, min(checkpoint.end ?? now(), now()).addingTimeInterval(-0.001))).end
                        state.mark(DateInterval(start: start, end: end))
                    }
                } else if let start = AutomationConfig.parseDate(record.start) {
                    let first = try window(start)
                    let endDate = max(start, (AutomationConfig.parseDate(record.end) ?? start).addingTimeInterval(-0.001))
                    let last = try window(endDate)
                    guard let range = clipped(DateInterval(start: first.start, end: last.end)) else { continue }
                    if let old = state.sampleWindows[record.recordId] { state.mark(old) }
                    state.sampleWindows[record.recordId] = range; state.mark(range)
                }
            }
        }
        var records: [HealthRecord] = []
        // A bounded number of snapshot queries per read lets the engine enforce its shared budget.
        for _ in 0..<min(limit, 20) {
            try Task.checkCancellation()
            guard let range = state.dirty.first else { break }
            let w = try window(range.start)
            let payload = try await source.snapshot(task: task, selection: selection, window: w)
            let record = HealthRecord(op: payload == nil ? .delete : .upsert, typeIdentifier: selection.id, recordId: w.id,
                start: HealthTimestamp.string(w.start), end: HealthTimestamp.string(w.end),
                source: RecordSource(id: "org.healthrelay.aggregate", name: "HealthRelay"), payload: payload)
            let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
            let hash = SHA256.hash(data: try encoder.encode(record)).map { String(format: "%02x", $0) }.joined()
            if state.hashes[w.id] != hash {
                // Empty windows are tombstones, including windows found by an unknown-deletion sweep.
                records.append(record); state.hashes[w.id] = hash
            }
            state.dirty.removeFirst()
            if w.end < range.end { state.dirty.insert(DateInterval(start: w.end, end: range.end), at: 0) }
        }
        state.trim(); next.aggregate = state
        return ReadPage(records: records, anchor: next.anchor, hasMore: !state.dirty.isEmpty || state.moreChanges, checkpoint: next)
    }
}

public enum SleepSummary {
    public static func payload(records: [HealthRecord], window: AggregateWindow, timeZone: String) -> [String: JSONValue]? {
        var stages: [Int: [DateInterval]] = [:]
        for record in records {
            guard case .number(let stage) = record.payload?["value"], let start = AutomationConfig.parseDate(record.start), let end = AutomationConfig.parseDate(record.end) else { continue }
            let a = max(start, window.start), b = min(end, window.end)
            if b > a { stages[Int(stage), default: []].append(DateInterval(start: a, end: b)) }
        }
        guard !stages.isEmpty else { return nil }
        func merged(_ values: [DateInterval]) -> [DateInterval] {
            var result: [DateInterval] = []
            for value in values.sorted(by: { $0.start < $1.start }) {
                if let last = result.last, value.start <= last.end { result[result.count - 1] = DateInterval(start: last.start, end: max(value.end, last.end)) }
                else { result.append(value) }
            }
            return result
        }
        func hours(_ values: [DateInterval]) -> Double { merged(values).reduce(0) { $0 + $1.duration } / 3600 }
        let asleep = merged([1,3,4,5].flatMap { stages[$0] ?? [] }), inBed = merged(stages[0] ?? [])
        var payload: [String: JSONValue] = ["aggregation": .bool(true), "unit": .string("hr"), "totalSleep": .number(hours(asleep)), "asleep": .number(hours(asleep))]
        for (key, stage) in [("core",3),("deep",4),("rem",5),("awake",2),("inBed",0)] { payload[key] = .number(hours(stages[stage] ?? [])) }
        for (prefix, segments) in [("sleep",asleep),("inBed",inBed)] {
            if let first = segments.first, let last = segments.last { payload[prefix + "Start"] = .string(HealthTimestamp.string(first.start)); payload[prefix + "End"] = .string(HealthTimestamp.string(last.end)) }
        }
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.timeZone = TimeZone(identifier: timeZone); formatter.dateFormat = "yyyy-MM-dd"
        payload["sleepDate"] = .string(formatter.string(from: window.end.addingTimeInterval(-1)))
        return payload
    }
}
