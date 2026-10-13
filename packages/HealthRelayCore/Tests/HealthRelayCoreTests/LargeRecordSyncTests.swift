import Foundation
import XCTest
@testable import HealthRelayCore

@MainActor final class LargeRecordSyncTests: XCTestCase {
    func testOversizedWorkoutIsReadOnceAndNeverCommittedUntilItFits() async throws {
        var task = AutomationConfig.newTask()
        task.data.family = .workout
        task.data.selections = [MetricSelection(typeIdentifier: "HKWorkoutType")]
        task.destination.url = "https://receiver.example/ingest"
        task.execution.batchMaxBytes = 1024
        let reader = LargeWorkoutReader(), sender = LargeWorkoutSender()
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let journal = SyncJournal(directory: directory)
        let engine = SyncEngine(reader: reader, sender: sender, journal: journal)
        let failed = await engine.run(task)
        XCTAssertEqual(failed.state, .failed)
        XCTAssertEqual(reader.readCount, 1, "Reducing page size cannot make one complete workout smaller")
        XCTAssertTrue(sender.uploads.isEmpty)
        XCTAssertTrue(try journal.load(task.id).checkpoints.isEmpty)
        XCTAssertNil(try journal.load(task.id).pending)
        XCTAssertTrue(failed.message.contains("KiB"))
        task.execution.batchMaxBytes = 64 * 1024
        let succeeded = await engine.run(task)
        XCTAssertEqual(succeeded.state, .succeeded)
        XCTAssertEqual(sender.uploads.count, 1)
        XCTAssertEqual(try journal.load(task.id).checkpoints.values.first?.anchor, Data("finished".utf8))
        let batch = try JSONDecoder().decode(UploadBatch.self, from: XCTUnwrap(sender.uploads.first).body)
        XCTAssertEqual(batch.records.first?.payload?["routeEvidence"], .string(String(repeating: "x", count: 4096)))
    }
}

@MainActor private final class LargeWorkoutReader: HealthDataReader {
    var readCount = 0
    func read(task: AutomationConfig, selection: MetricSelection, checkpoint: TypeCheckpoint, limit: Int) async throws -> ReadPage {
        readCount += 1
        let record = HealthRecord(op: .upsert, typeIdentifier: selection.id, recordId: "synthetic-workout",
                                  start: "2026-10-13T00:00:00Z", end: "2026-10-13T01:00:00Z",
                                  source: RecordSource(id: "synthetic", name: "Synthetic Watch"),
                                  payload: ["durationSeconds": .number(3600), "routeEvidence": .string(String(repeating: "x", count: 4096))])
        return ReadPage(records: checkpoint.anchor == nil ? [record] : [], anchor: Data("finished".utf8), hasMore: false)
    }
}

@MainActor private final class LargeWorkoutSender: UploadSender {
    var uploads: [PendingUpload] = []
    func send(_ upload: PendingUpload, destination: HTTPDestination) async throws -> Int {
        uploads.append(upload)
        return 204
    }
}
