import Foundation
import XCTest
@testable import HealthRelayCore

final class ServiceAutomationTests: XCTestCase {
    private var root: URL {
        (0..<5).reduce(URL(fileURLWithPath: #filePath)) { url, _ in url.deletingLastPathComponent() }
    }

    func testServiceProfilesValidateAndEncodeForTheMigratedWorker() throws {
        var documents: [[String: Any]] = []
        // Current times keep the same fixtures inside the service's rolling retention window.
        let now = Date()
        for name in ["heart", "hrv", "activity", "sleep", "workouts"] {
            let path = root.appendingPathComponent("examples/watch-monitor/\(name).json")
            let task = try ConfigurationCodec.decode(Data(contentsOf: path))
            XCTAssertEqual(task.validationIssues(), [], name)
            XCTAssertFalse(task.enabled)
            XCTAssertEqual(task.device, .iPhone)
            XCTAssertEqual(task.destination.requiredSecretHeaders, ["X-API-Key"])
            XCTAssertNil(task.destination.secretHeaders)
            XCTAssertNil(task.destination.credentialRef)
            XCTAssertEqual(task.destination.acknowledgement, .http2xx)
            XCTAssertEqual(URL(string: task.destination.url)?.host, "health.example.com")
            var bound = task
            bound.destination.secretHeaders = ["X-API-Key": "fixture-only"]
            bound.destination.requiredSecretHeaders = nil
            XCTAssertEqual(bound.executionIssues, [], name)
            let reference = now.addingTimeInterval(-86400)
            let window = try AggregateWindow.containing(reference,
                grouping: task.export.mode == .aggregate ? task.export.grouping : .days,
                timeZone: task.export.timeZone)
            let records = task.data.selections.map { selection -> HealthRecord in
                var payload: [String: JSONValue]
                let start: Date, end: Date
                if name == "workouts" {
                    start = reference.addingTimeInterval(-1800); end = reference
                    payload = ["activityType": .number(37), "durationSeconds": .number(1800),
                        "statistics": .object(["HKQuantityTypeIdentifierActiveEnergyBurned":
                            .object(["sum": .number(180), "unit": .string("kcal")])])]
                } else if name == "sleep" {
                    start = reference.addingTimeInterval(-3600); end = reference
                    payload = ["value": .number(3)]
                } else {
                    start = window.start; end = window.end
                    payload = ["aggregation": .bool(true), "unit": .string(selection.unit!), "value": .number(60)]
                    for statistic in task.statistics(for: selection) { payload[statistic.rawValue] = .number(60) }
                }
                return HealthRecord(op: .upsert, typeIdentifier: selection.id, recordId: "synthetic-\(selection.id)",
                    start: HealthTimestamp.string(start), end: HealthTimestamp.string(end),
                    source: RecordSource(id: "synthetic", name: name == "sleep" ? "Synthetic Watch" : "HealthRelay"), payload: payload)
            }
            let batch = UploadBatch(task: task, records: records)
            let encoded = try BatchEncoder.encode(batch, format: task.export.format, timeZone: task.export.timeZone)
            var headers = HEARequestMetadata.headers(task: task, batchID: batch.batchId)
            for (key, value) in task.destination.headers { headers[key] = value }
            headers["Content-Type"] = encoded.contentType
            let body = try JSONSerialization.jsonObject(with: encoded.body)
            documents.append(["name": name, "path": URL(string: task.destination.url)!.path,
                "headers": headers, "body": body, "recordCount": records.count])
        }
        XCTAssertEqual(documents.count, 5)
        // Opt-in synthetic artifact for the cross-language contract test; never reads device data.
        if let output = ProcessInfo.processInfo.environment["HEALTHRELAY_SERVICE_FIXTURES"] {
            try JSONSerialization.data(withJSONObject: documents, options: [.sortedKeys]).write(to: URL(fileURLWithPath: output))
        }
    }
}
