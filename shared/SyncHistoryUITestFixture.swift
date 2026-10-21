#if DEBUG && targetEnvironment(simulator)
import Foundation
import HealthRelayCore
import SwiftUI

/// Local UI fixtures only; never read HealthKit or send an upload.
enum SyncHistoryUITestFixture {
    @MainActor static func initialScreen(_ history: SyncHistoryStore) -> AnyView? {
        let args = ProcessInfo.processInfo.arguments
        guard args.contains("--ui-testing") else { return nil }
        if args.contains("--history-detail") { return AnyView(SyncHistoryDetailView(history: history, entryID: "ui-0")) }
        if args.contains("--show-history") { return AnyView(SyncHistoryView(history: history)) }
        return nil
    }
    static func install(_ history: SyncHistoryStore, device: ExecutionDevice) {
        let args = ProcessInfo.processInfo.arguments
        guard args.contains("--ui-testing"), let mode = args.first(where: { $0.hasPrefix("--history-fixture=") }) else { return }
        do {
            try? FileManager.default.removeItem(at: history.file.deletingLastPathComponent())
            if mode == "--history-fixture=error" {
                try FileManager.default.createDirectory(at: history.file.deletingLastPathComponent(), withIntermediateDirectories: true)
                try Data("Unreadable UI fixture".utf8).write(to: history.file)
                return
            }
            guard mode == "--history-fixture=full" else { return }
            let now = Date(), taskID = UUID(uuidString: "11111111-1111-4111-8111-111111111111")!
            let context = SyncHistoryContext(taskID: taskID, taskName: "界面验收 · 日常同步", device: device, kind: .daily, destinationHost: "example.invalid")
            let summary = SyncHistorySummary(records: [
                HealthRecord(op: .upsert, typeIdentifier: "HKQuantityTypeIdentifierHeartRate", recordId: "ui-heart", start: HealthTimestamp.string(now.addingTimeInterval(-60)), payload: ["value": .number(72), "unit": .string("count/min")]),
                HealthRecord(op: .upsert, typeIdentifier: "HKQuantityTypeIdentifierStepCount", recordId: "ui-steps", start: HealthTimestamp.string(now.addingTimeInterval(-60)), payload: ["value": .number(80), "unit": .string("count")])
            ])
            try history.apply((0..<55).flatMap { i -> [SyncHistoryEvent] in
                let date = now.addingTimeInterval(-Double(i) * 60), id = "ui-\(i)"
                return [
                    SyncHistoryEvent(id: id + "-q", entryID: id, context: context, batchID: id, date: date.addingTimeInterval(-2), state: .queued, summary: summary),
                    SyncHistoryEvent(id: id + "-a", entryID: id, context: context, batchID: id, date: date.addingTimeInterval(-1), state: .sending, attemptID: id),
                    SyncHistoryEvent(id: id + "-r", entryID: id, context: context, batchID: id, date: date, state: i % 2 == 0 ? .succeeded : .failed, attemptID: id, message: i % 2 == 0 ? nil : "离线，等待下次重试", httpStatus: i % 2 == 0 ? 200 : nil)
                ]
            })
        } catch { assertionFailure("History UI fixture: \(error)") }
    }
}
#endif
