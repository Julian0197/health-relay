import Foundation
import XCTest
@testable import HealthRelayCore

@MainActor final class HEAConfigurationTests: XCTestCase {
    private func task(_ format: String = "hea.v2") -> AutomationConfig {
        var task = AutomationConfig.newTask(); task.export.format = format; task.export.timeZone = "UTC"
        task.destination.url = "https://receiver.example/ingest"
        task.data.selections = [MetricSelection(typeIdentifier: "HKCategoryTypeIdentifierSexualActivity")]
        return task
    }
    private func record(_ id: String = "HKCategoryTypeIdentifierSexualActivity") -> HealthRecord {
        HealthRecord(op: .upsert, typeIdentifier: id, recordId: "sample", start: "2026-01-01T00:00:00Z", end: "2026-01-01T00:01:00Z", payload: ["value": .number(0)])
    }
    func testExplicitFamilyRoutingAndMismatchesAtBothBoundaries() throws {
        let sample = record(), batch = UploadBatch(task: task(), records: [record()])
        for format in ["hea.v1", "hea.v2"] {
            for (family, key) in [(HEADataType.automatic, "metrics"), (.healthMetrics, "metrics"), (.cycleTracking, "cycleTracking")] {
                let encoded = try BatchEncoder.encode(batch, format: format, heaDataType: family)
                let data = try JSONDecoder().decode(JSONValue.self, from: encoded.body).object?["data"]?.object
                XCTAssertEqual(Set(data?.keys.map { $0 } ?? []), [key])
            }
            XCTAssertThrowsError(try BatchEncoder.encode(batch, format: format, heaDataType: .symptoms))
            XCTAssertThrowsError(try HEAEncoder.encode(batch, timeZone: "UTC", version: format == "hea.v1" ? 1 : 2, heaDataType: .ecg))
            var configured = task(format); configured.export.heaDataType = .symptoms
            XCTAssertFalse(configured.executionCapabilityIssues.isEmpty)
            configured.export.heaDataType = .cycleTracking
            XCTAssertTrue(configured.executionCapabilityIssues.isEmpty)
            var menstrual = sample; menstrual.typeIdentifier = "HKCategoryTypeIdentifierMenstrualFlow"; menstrual.payload?["value"] = .number(2)
            let contextual = try BatchEncoder.encode(UploadBatch(task: configured, records: [menstrual]), format: format, heaDataType: .symptoms)
            XCTAssertNotNil(try JSONDecoder().decode(JSONValue.self, from: contextual.body).object?["data"]?.object?["symptoms"])
        }
        for family in HEADataType.allCases where ![.automatic, .healthMetrics].contains(family) {
            XCTAssertThrowsError(try HEACSVEncoder.encode(UploadBatch(task: task(), records: []), timeZone: "UTC", heaDataType: family))
        }
    }
    func testSelectionPersistsInConfigSnapshotAndBackfillAndChangesFingerprint() throws {
        var configured = task(); let original = try SyncIdentity.fingerprint(configured)
        let legacyData = try JSONEncoder().encode(configured)
        XCTAssertFalse(String(decoding: legacyData, as: UTF8.self).contains("heaDataType"))
        XCTAssertNil(try JSONDecoder().decode(AutomationConfig.self, from: legacyData).export.heaDataType)
        configured.export.heaDataType = .cycleTracking
        XCTAssertNotEqual(try SyncIdentity.fingerprint(configured), original)
        XCTAssertEqual(try JSONDecoder().decode(AutomationConfig.self, from: JSONEncoder().encode(configured)).export.heaDataType, .cycleTracking)
        let job = try BackfillJob(task: configured, start: Date(timeIntervalSince1970: 0), end: Date(timeIntervalSince1970: 3600))
        XCTAssertEqual(job.task.export.heaDataType, .cycleTracking)
        configured.device = .watch
        let snapshot = try WatchConfigurationSnapshot(tasks: [configured])
        let restored = try JSONDecoder().decode(WatchConfigurationSnapshot.self, from: JSONEncoder().encode(snapshot))
        XCTAssertEqual(restored.tasks.first?.export.heaDataType, .cycleTracking)
    }
    func testCSVExecutionRequiresAggregatableMetricsAndAggregateMode() {
        var configured = task("hea.csv")
        configured.data.selections = [MetricSelection(typeIdentifier: "HKQuantityTypeIdentifierStepCount", unit: "count")]
        XCTAssertTrue(configured.executionCapabilityIssues.contains { $0.contains("汇总") })
        configured.export.mode = .aggregate; configured.export.grouping = .days
        XCTAssertTrue(configured.executionCapabilityIssues.isEmpty)
        XCTAssertTrue(configured.validationIssues().isEmpty)
        for id in ["HKCategoryTypeIdentifierMindfulSession", "HKCategoryTypeIdentifierSexualActivity", "HKCorrelationTypeIdentifierBloodPressure", "HKDataTypeStateOfMind"] {
            configured.data.selections = [MetricSelection(typeIdentifier: id)]
            XCTAssertFalse(configured.executionCapabilityIssues.isEmpty, id)
        }
        configured.data.selections = [MetricSelection(typeIdentifier: "HKCategoryTypeIdentifierSleepAnalysis")]
        XCTAssertTrue(configured.executionCapabilityIssues.isEmpty)
    }
    func testCSVRequiresOneStatisticPerScalarAndGatesAmbiguousRecoveryHRV() {
        var configured = task("hea.csv")
        configured.export.mode = .aggregate; configured.export.grouping = .days
        var scalar = MetricSelection(typeIdentifier: "HKQuantityTypeIdentifierBodyMass", unit: "kg")
        configured.data.selections = [scalar]
        XCTAssertTrue(configured.executionCapabilityIssues.contains { $0.contains("统计") })
        for statistic in [ExportSettings.Statistic.average, .minimum, .maximum] {
            scalar.statistics = [statistic]; configured.data.selections = [scalar]
            XCTAssertTrue(configured.executionCapabilityIssues.isEmpty)
        }
        scalar.statistics = [.minimum, .maximum]; configured.data.selections = [scalar]
        XCTAssertTrue(configured.executionCapabilityIssues.contains { $0.contains("统计") })
        var heart = MetricSelection(typeIdentifier: "HKQuantityTypeIdentifierHeartRate", unit: "count/min")
        configured.data.selections = [heart]
        XCTAssertTrue(configured.executionCapabilityIssues.isEmpty)
        heart.statistics = [.sum]; configured.data.selections = [heart]
        XCTAssertTrue(configured.executionCapabilityIssues.contains { $0.contains("统计") })
        var extensionMetric = MetricSelection(typeIdentifier: "HKQuantityTypeIdentifierHeartRateVariabilityRMSSD", unit: "ms")
        extensionMetric.statistics = [.average]; configured.data.selections = [extensionMetric]
        XCTAssertTrue(configured.executionCapabilityIssues.contains { $0.contains("映射") && $0.contains("HealthRelay JSON") })
        configured.export.format = "hea.v2"
        XCTAssertTrue(configured.executionCapabilityIssues.isEmpty, "CSV gate must not change JSON behavior")
    }
    func testCSVSyncIncludesAllSelectedSparseColumnsAndFrozenRetry() async throws {
        var configured = task("hea.csv")
        configured.export.mode = .aggregate; configured.export.grouping = .days
        var oxygen = MetricSelection(typeIdentifier: "HKQuantityTypeIdentifierOxygenSaturation", unit: "%")
        oxygen.statistics = [.average]
        configured.data.selections = [MetricSelection(typeIdentifier: "HKQuantityTypeIdentifierStepCount", unit: "count"), oxygen,
                                      MetricSelection(typeIdentifier: "HKCategoryTypeIdentifierSleepAnalysis")]
        var sample = record("HKQuantityTypeIdentifierStepCount")
        sample.payload = ["aggregation": .bool(true), "unit": .string("count"), "value": .number(10), "sum": .number(10)]
        let reader = CSVSelectionReader(records: [sample]), sender = HEAProfileSender()
        let journal = SyncJournal(directory: .temporaryDirectory.appendingPathComponent(UUID().uuidString))
        let first = await SyncEngine(reader: reader, sender: sender, journal: journal).run(configured)
        XCTAssertEqual(first.state, .failed)
        let pending = try XCTUnwrap(journal.load(configured.id).pending)
        let table = try HEACSVObservedTests.table(EncodedBatch(body: pending.body, contentType: pending.contentType))
        XCTAssertEqual(table, "日期/时间,步数 (步),睡眠分析 [Total] (小时),睡眠分析 [睡眠时长] (小时),睡眠分析 [在床上] (小时),睡眠分析 [核心] (小时),睡眠分析 [深度] (小时),睡眠分析 [快速动眼期] (小时),睡眠分析 [清醒] (小时),血氧饱和度 (%)\n2026-01-01 00:00:00,10,,,,,,,,\n")
        XCTAssertEqual(pending.recordCount, 1)
        XCTAssertTrue(try journal.load(configured.id).checkpoints.isEmpty)
        var changed = configured; changed.data.selections.removeLast()
        let blocked = await SyncEngine(reader: reader, sender: sender, journal: journal).run(changed)
        XCTAssertEqual(blocked.state, .failed); XCTAssertEqual(reader.reads, 1)
        sender.fail = false
        let retry = await SyncEngine(reader: reader, sender: sender, journal: SyncJournal(directory: journal.directory)).run(configured)
        XCTAssertEqual(retry.state, .succeeded); XCTAssertEqual(retry.records, 1)
        XCTAssertEqual(sender.uploads[1].body, pending.body)
        XCTAssertEqual(sender.uploads[1].contentType, pending.contentType)
        XCTAssertEqual(sender.uploads[1].headers, pending.headers)
        XCTAssertEqual(sender.uploads[1].batchID, pending.batchID)
        XCTAssertNil(try journal.load(configured.id).pending)
    }
    func testLegacyFrozenCSVReplaysBeforeNewProfileCapabilityGate() async throws {
        for id in ["HKQuantityTypeIdentifierBodyMass", "HKQuantityTypeIdentifierHeartRateVariabilityRMSSD"] {
            var configured = task("hea.csv")
            configured.export.mode = .aggregate; configured.export.grouping = .days
            var selection = MetricSelection(typeIdentifier: id, unit: id.hasSuffix("BodyMass") ? "kg" : "ms")
            if id.hasSuffix("RMSSD") { selection.statistics = [.average] }
            configured.data.selections = [selection]
            XCTAssertTrue(configured.validationIssues().isEmpty)
            XCTAssertFalse(configured.executionCapabilityIssues.isEmpty)
            let journal = SyncJournal(directory: .temporaryDirectory.appendingPathComponent(UUID().uuidString))
            var state = SyncState()
            let frozen = Data("--legacy-boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"legacy.csv\"\r\n\r\n\"Date\",\"Value\"\r\n\"2026-01-01 00:00:00 +0000\",\"2\"\r\n--legacy-boundary--\r\n".utf8)
            state.pending = PendingUpload(batchID: "legacy-csv", body: frozen, contentType: "multipart/form-data; boundary=legacy-boundary", recordCount: 1,
                checkpointKey: "legacy-checkpoint", checkpoint: TypeCheckpoint(start: Date(timeIntervalSince1970: 0), anchor: Data("confirmed-legacy".utf8)), configurationFingerprint: try SyncIdentity.fingerprint(configured))
            state.pending?.headers = ["automation-id": configured.id.uuidString.lowercased(), "session-id": "legacy-csv"]
            try journal.save(state, for: configured.id)
            let reader = CSVSelectionReader(records: []), sender = LegacyCSVReceiptSender()
            var changed = configured; changed.data.selections[0].statistics = [.minimum]
            let rejected = await SyncEngine(reader: reader, sender: sender, journal: journal).run(changed)
            XCTAssertEqual(rejected.state, .failed); XCTAssertTrue(sender.uploads.isEmpty); XCTAssertEqual(reader.reads, 0)
            let result = await SyncEngine(reader: reader, sender: sender, journal: journal).run(configured)
            XCTAssertEqual(result.state, .failed, "New reads remain blocked by the new profile")
            XCTAssertEqual(result.records, 1, "The frozen request was acknowledged")
            XCTAssertEqual(reader.reads, 0)
            let sent = try XCTUnwrap(sender.uploads.first)
            XCTAssertEqual(sent.body, frozen); XCTAssertEqual(sent.contentType, state.pending?.contentType)
            XCTAssertEqual(sent.headers, state.pending?.headers); XCTAssertEqual(sent.batchID, "legacy-csv")
            let saved = try journal.load(configured.id)
            XCTAssertNil(saved.pending)
            XCTAssertEqual(saved.checkpoints["legacy-checkpoint"]?.anchor, Data("confirmed-legacy".utf8))
            XCTAssertNotNil(saved.lastConfirmedAt)
        }
    }
    func testBlockedFamiliesOfferActionableNativeFallback() {
        for id in ["HKMedicationDoseEventTypeIdentifierMedicationDoseEvent", "HKDataTypeUserAnnotatedMedicationConcept", "HKCategoryTypeIdentifierAppleStandHour", "HKCategoryTypeIdentifierHandwashingEvent", "HKCategoryTypeIdentifierToothbrushingEvent"] {
            var configured = task(); configured.data.selections = [MetricSelection(typeIdentifier: id)]
            XCTAssertTrue(configured.executionCapabilityIssues.contains { $0.contains("HealthRelay JSON") && $0.contains("HEA") }, id)
        }
    }
    func testDirectDeletionRejectsBothVersionsAndMixedFamilies() throws {
        var deleted = record(); deleted.op = .delete; deleted.payload = nil
        let symptom = HealthRecord(op: .upsert, typeIdentifier: "HKCategoryTypeIdentifierHeadache", recordId: "symptom", start: deleted.start, end: deleted.end, payload: ["value": .number(2)])
        for format in ["hea.v1", "hea.v2", "hea.csv"] {
            XCTAssertThrowsError(try BatchEncoder.encode(UploadBatch(task: task(), records: [deleted]), format: format))
            XCTAssertThrowsError(try BatchEncoder.encode(UploadBatch(task: task(), records: [symptom, deleted]), format: format))
        }
    }
    func testConfigMismatchStopsBeforeReaderAndSender() async throws {
        var configured = task(); configured.export.heaDataType = .workouts
        let reader = HEAProfileReader(records: [record()]), sender = HEAProfileSender()
        let journal = SyncJournal(directory: .temporaryDirectory.appendingPathComponent(UUID().uuidString))
        let result = await SyncEngine(reader: reader, sender: sender, journal: journal).run(configured)
        XCTAssertEqual(result.state, .failed); XCTAssertEqual(reader.reads, 0); XCTAssertTrue(sender.uploads.isEmpty)
    }
    func testSyncUsesExplicitFamilyAndExactPendingBodySurvivesRestart() async throws {
        for format in ["hea.v1", "hea.v2", "hea.csv"] {
            var configured = task(format)
            var sample = record()
            if format == "hea.csv" {
                configured.data.selections = [MetricSelection(typeIdentifier: "HKQuantityTypeIdentifierStepCount", unit: "count")]
                configured.export.heaDataType = .healthMetrics; configured.export.mode = .aggregate; configured.export.grouping = .days
                sample.typeIdentifier = "HKQuantityTypeIdentifierStepCount"; sample.payload = ["value": .number(10), "unit": .string("count"), "aggregation": .bool(true)]
            } else { configured.export.heaDataType = .cycleTracking }
            let reader = HEAProfileReader(records: [sample]), sender = HEAProfileSender()
            let journal = SyncJournal(directory: .temporaryDirectory.appendingPathComponent(UUID().uuidString))
            let first = await SyncEngine(reader: reader, sender: sender, journal: journal).run(configured)
            XCTAssertEqual(first.state, .failed)
            let pending = try XCTUnwrap(journal.load(configured.id).pending)
            XCTAssertTrue(try journal.load(configured.id).checkpoints.isEmpty)
            if format != "hea.csv" {
                let data = try JSONDecoder().decode(JSONValue.self, from: pending.body).object?["data"]?.object
                XCTAssertNotNil(data?["cycleTracking"]); XCTAssertNil(data?["metrics"])
            }
            var changed = configured; changed.export.heaDataType = format == "hea.csv" ? .automatic : .healthMetrics
            let blocked = await SyncEngine(reader: reader, sender: sender, journal: journal).run(changed)
            XCTAssertEqual(blocked.state, .failed); XCTAssertEqual(reader.reads, 1); XCTAssertEqual(sender.uploads.count, 1)
            XCTAssertEqual(try journal.load(configured.id).pending?.body, pending.body)
            sender.fail = false
            let restoredJournal = SyncJournal(directory: journal.directory)
            let retried = await SyncEngine(reader: reader, sender: sender, journal: restoredJournal).run(configured)
            XCTAssertEqual(retried.state, .succeeded)
            XCTAssertEqual(sender.uploads[1].body, pending.body); XCTAssertEqual(sender.uploads[1].batchID, pending.batchID)
            XCTAssertEqual(sender.uploads[1].contentType, pending.contentType); XCTAssertEqual(sender.uploads[1].headers, pending.headers)
            XCTAssertNil(try restoredJournal.load(configured.id).pending)
            XCTAssertEqual(try restoredJournal.load(configured.id).checkpoints.values.first?.anchor, Data("next".utf8))
        }
    }
    func testMixedAutomaticV1SyncOmitDeletionKeepsOtherFamilies() async throws {
        var configured = task("hea.v1"); configured.export.deletionPolicy = .omit
        var deleted = record(); deleted.op = .delete; deleted.payload = nil
        var symptom = record("HKCategoryTypeIdentifierHeadache"); symptom.payload?["value"] = .number(2)
        let reader = HEAProfileReader(records: [record(), symptom, deleted]), sender = HEAProfileSender(); sender.fail = false
        let journal = SyncJournal(directory: .temporaryDirectory.appendingPathComponent(UUID().uuidString))
        let result = await SyncEngine(reader: reader, sender: sender, journal: journal).run(configured)
        XCTAssertEqual(result.state, .succeeded); XCTAssertEqual(result.omittedDeletions, 1)
        XCTAssertEqual(sender.uploads.first?.recordCount, 2)
        let root = try JSONDecoder().decode(JSONValue.self, from: XCTUnwrap(sender.uploads.first?.body))
        XCTAssertEqual(Set(root.object?["data"]?.object?.keys.map { $0 } ?? []), ["metrics", "symptoms"])
        XCTAssertFalse(try journal.load(configured.id).checkpoints.isEmpty)
    }
}

@MainActor private final class HEAProfileReader: HealthDataReader {
    let records: [HealthRecord]
    var reads = 0
    init(records: [HealthRecord]) { self.records = records }
    func read(task: AutomationConfig, selection: MetricSelection, checkpoint: TypeCheckpoint, limit: Int) async throws -> ReadPage {
        reads += 1
        return ReadPage(records: checkpoint.anchor == nil ? records : [], anchor: Data("next".utf8), hasMore: false)
    }
}
@MainActor private final class HEAProfileSender: UploadSender {
    var fail = true, uploads: [PendingUpload] = []
    func send(_ upload: PendingUpload, destination: HTTPDestination) async throws -> Int {
        uploads.append(upload)
        if fail { throw ConfigurationError("synthetic offline") }; return 204
    }
}

@MainActor private final class CSVSelectionReader: HealthDataReader {
    let records: [HealthRecord]
    var reads = 0
    init(records: [HealthRecord]) { self.records = records }
    func read(task: AutomationConfig, selection: MetricSelection, checkpoint: TypeCheckpoint, limit: Int) async throws -> ReadPage {
        reads += 1
        return ReadPage(records: checkpoint.anchor == nil ? records.filter { $0.typeIdentifier == selection.id } : [], anchor: Data("csv-next".utf8), hasMore: false)
    }
}

@MainActor private final class LegacyCSVReceiptSender: UploadSender {
    var uploads: [PendingUpload] = []
    func send(_ upload: PendingUpload, destination: HTTPDestination) async throws -> Int {
        uploads.append(upload)
        let receipt = try JSONSerialization.data(withJSONObject: ["batchId": upload.batchID, "committed": true, "accepted": upload.recordCount, "duplicates": 0])
        try HTTPAcknowledgement.validate(status: 200, data: receipt, batchID: upload.batchID, count: upload.recordCount, mode: .receipt)
        return 200
    }
}
