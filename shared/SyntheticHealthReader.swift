import Foundation
import HealthRelayCore

#if DEBUG && targetEnvironment(simulator)
/// Synthetic records are available only to an explicit simulator acceptance run.
/// This reader is absent from physical-device and Release builds.
@MainActor final class SyntheticHealthReader: HealthDataReader {
    func read(task: AutomationConfig, selection: MetricSelection, checkpoint: TypeCheckpoint, limit: Int) async throws -> ReadPage {
        guard checkpoint.anchor == nil else { return ReadPage(records: [], anchor: checkpoint.anchor, hasMore: false) }
        var payload: [String: JSONValue] = ["value": .number(70), "unit": .string(selection.unit ?? "count")]
        if task.export.mode == .aggregate {
            payload["aggregation"] = .bool(true)
            for statistic in task.statistics(for: selection) { payload[statistic.rawValue] = .number(70) }
        }
        let records = [HealthRecord(op: .upsert, typeIdentifier: selection.id, recordId: "synthetic-quantity-001", start: "2026-10-12T00:00:00Z", end: "2026-10-12T00:00:00Z", source: RecordSource(id: "test.synthetic", name: "Synthetic acceptance"), payload: payload)]
        return ReadPage(records: records, anchor: Data("synthetic-cursor-1".utf8), hasMore: false)
    }
}
#endif
