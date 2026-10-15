import Foundation
import Testing
@testable import HealthRelayCore

private func exchangeData(_ task: AutomationConfig, change: (inout [String: Any]) -> Void = { _ in }) throws -> Data {
    var object = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(task)) as? [String: Any])
    change(&object)
    return try JSONSerialization.data(withJSONObject: object)
}

private func exchangeBundleData(_ tasks: [AutomationConfig]) throws -> Data {
    let objects = try tasks.map { try JSONSerialization.jsonObject(with: JSONEncoder().encode($0)) }
    return try JSONSerialization.data(withJSONObject: ["kind": "healthrelay.automations", "schemaVersion": 1, "tasks": objects])
}

@Test func exchangeTemplatesAndBundleRoundTrip() throws {
    let tasks = [ConfigurationExchange.template(), ConfigurationExchange.template(device: .watch)]
    let data = try ConfigurationExchange.export(tasks)
    let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    #expect(object["kind"] as? String == "healthrelay.automations")
    let report = ConfigurationExchange.inspect(data)
    #expect(report.valid)
    #expect(report.tasks == tasks)
    #expect(report.issues.allSatisfy { $0.severity == .warning })
    #expect(try JSONDecoder().decode(ConfigurationInspection.self, from: JSONEncoder().encode(report)).tasks == tasks)
}

@Test func exchangeAcceptsSingleJSONAndExactlyOneJSONFence() throws {
    var task = ConfigurationExchange.template()
    task.enabled = true
    let data = try exchangeData(task)
    let fenced = Data("  \n```json\n\(String(decoding: data, as: UTF8.self))\n```\n".utf8)
    let crlfFenced = Data("```json\r\n\(String(decoding: data, as: UTF8.self))\r\n```".utf8)
    for input in [data, fenced, crlfFenced] {
        let report = ConfigurationExchange.inspect(input)
        #expect(report.valid)
        #expect(report.tasks.first?.enabled == false)
    }
    #expect(!ConfigurationExchange.inspect(Data("Here it is:\n\(String(decoding: fenced, as: UTF8.self))".utf8)).valid)
    #expect(!ConfigurationExchange.inspect(Data("```json\n{}\n```\n```json\n{}\n```".utf8)).valid)
}

@Test func exchangeRejectsMalformedUnknownAndMistypedFieldsWithoutEchoingValues() throws {
    let task = ConfigurationExchange.template()
    let changes: [(String, (inout [String: Any]) -> Void)] = [
        ("/surprise", { $0["surprise"] = "private-value" }),
        ("/execution/reminder/surprise", { object in
            var execution = object["execution"] as! [String: Any]
            execution["reminder"] = ["enabled": false, "frequency": "daily", "hour": 9, "minute": 0, "weekdays": [2], "surprise": "private-value"]
            object["execution"] = execution
        }),
        ("/device", { $0["device"] = "private-value" }),
        ("/revision", { $0["revision"] = "private-value" }),
        ("/schemaVersion", { $0["schemaVersion"] = 99 }),
        ("/name", { $0.removeValue(forKey: "name") })
    ]
    for (path, change) in changes {
        let report = ConfigurationExchange.inspect(try exchangeData(task, change: change))
        #expect(!report.valid)
        #expect(report.issues.contains { $0.path == path && $0.severity == .error })
        #expect(!String(decoding: try JSONEncoder().encode(report.issues), as: UTF8.self).contains("private-value"))
    }
    let malformed = ConfigurationExchange.inspect(Data("{\"secret\":\"private-value\"".utf8))
    #expect(!malformed.valid)
    #expect(malformed.issues.first?.path == "")
    #expect(!malformed.issues[0].message.contains("private-value"))
}

@Test func exchangeRedactsSecretsAndPreservesMissingAuthenticationAsWarning() throws {
    var task = ConfigurationExchange.template()
    task.destination.headers = ["Authorization": "secret-value", "X-Environment": "test"]
    task.destination.secretHeaders = ["X-Custom": "secret-reference"]
    task.destination.credentialRef = "legacy-reference"
    let report = ConfigurationExchange.inspect(try exchangeData(task))
    #expect(report.valid)
    #expect(report.issues.contains { $0.code == "authentication_required" && $0.severity == .warning })
    let imported = try #require(report.tasks.first)
    #expect(imported.destination.credentialHeader == "Authorization")
    let output = String(decoding: try JSONEncoder().encode(report), as: UTF8.self)
    for secret in ["secret-value", "secret-reference", "legacy-reference"] { #expect(!output.contains(secret)) }
    #expect(imported.destination.headers == ["X-Environment": "test"])
}

@Test func exchangeSemanticErrorsDoNotEchoUnknownMetricOrHeaderValues() throws {
    var task = ConfigurationExchange.template()
    task.data.selections = [MetricSelection(typeIdentifier: "private-value")]
    task.export.format = "hea.v2"
    task.destination.headers = ["content-type": "private-header-value"]
    let report = ConfigurationExchange.inspect(try exchangeData(task))
    #expect(!report.valid)
    let errors = String(decoding: try JSONEncoder().encode(report.issues), as: UTF8.self)
    #expect(!errors.contains("private-value"))
    #expect(!errors.contains("private-header-value"))
}

@Test func exchangeRejectsInvalidBundlesAndInputLimits() throws {
    let task = ConfigurationExchange.template()
    #expect(!ConfigurationExchange.inspect(try ConfigurationExchange.export([task, task])).valid)
    #expect(!ConfigurationExchange.inspect(try exchangeBundleData([])).valid)
    #expect(!ConfigurationExchange.inspect(try exchangeBundleData((0..<101).map { _ in ConfigurationExchange.template() })).valid)
    #expect(!ConfigurationExchange.inspect(Data(repeating: 32, count: 1_048_577)).valid)
    let badBundle = Data("{\"kind\":\"wrong\",\"schemaVersion\":1,\"tasks\":[]}".utf8)
    #expect(!ConfigurationExchange.inspect(badBundle).valid)
}

@Test func exchangeExportRejectsInvalidEnvelopeCountsAndEncodedSize() throws {
    #expect(throws: ConfigurationError.self) { try ConfigurationExchange.export([]) }
    let tasks = (0..<101).map { _ in ConfigurationExchange.template() }
    #expect(throws: ConfigurationError.self) { try ConfigurationExchange.export(tasks) }
    var oversized = ConfigurationExchange.template()
    oversized.name = String(repeating: "x", count: ConfigurationExchange.maximumInputBytes)
    #expect(throws: ConfigurationError.self) { try ConfigurationExchange.export([oversized]) }
    let legal = try ConfigurationExchange.export(Array(tasks.prefix(100)))
    let report = ConfigurationExchange.inspect(legal)
    #expect(report.valid && report.tasks.count == 100)
}

@Test func exchangeExportSizeLimitAppliesAfterSecretRemovalAndAllowsSemanticEdits() throws {
    var task = ConfigurationExchange.template()
    task.destination.headers = ["Authorization": String(repeating: "s", count: ConfigurationExchange.maximumInputBytes + 1), "X-Environment": "test"]
    let data = try ConfigurationExchange.export([task])
    #expect(data.count <= ConfigurationExchange.maximumInputBytes)
    let report = ConfigurationExchange.inspect(data)
    #expect(report.valid)
    let copy = try #require(report.tasks.first)
    #expect(copy.destination.headers == ["X-Environment": "test"])
    #expect(!copy.enabled)
    task.destination.url = "not-an-endpoint"
    let editable = try ConfigurationExchange.export([task])
    #expect(!ConfigurationExchange.inspect(editable).valid)
}

@Test func exchangeImportCreatesFreshDisabledCopies() throws {
    var task = ConfigurationExchange.template()
    task.revision = 8
    task.enabled = true
    let report = ConfigurationExchange.inspect(try exchangeData(task))
    let first = try #require(ConfigurationExchange.copiesForImport(report).first)
    let second = try #require(ConfigurationExchange.copiesForImport(report).first)
    #expect(first.id != task.id && first.id != second.id)
    #expect(first.revision == 1 && !first.enabled)
    #expect(first.name == task.name)
    #expect(throws: ConfigurationError.self) {
        try ConfigurationExchange.copiesForImport(ConfigurationExchange.inspect(Data("{}".utf8)))
    }
}

@Test func exchangeWatchCopiesValidateCapabilitiesAndDoNotMutateOriginal() throws {
    let task = ConfigurationExchange.template()
    let copy = try ConfigurationExchange.watchCopy(task)
    #expect(copy.device == .watch && copy.id != task.id && copy.revision == 1 && !copy.enabled)
    #expect(copy.name.hasSuffix(" · Watch"))
    #expect(task.device == .iPhone)
    #expect(throws: Never.self) { try WatchConfigurationSnapshot(tasks: [copy]) }
    var unsupported = task
    // Every current catalog metric has a Watch minimum. An unavailable identifier
    // must still be rejected instead of silently copied to the Watch.
    unsupported.data.selections = [MetricSelection(typeIdentifier: "UnavailableWatchMetric")]
    #expect(throws: ConfigurationError.self) { try ConfigurationExchange.watchCopy(unsupported) }
    unsupported = task
    unsupported.export.format = "hea.v2"
    unsupported.export.heaDataType = .medications
    #expect(throws: ConfigurationError.self) { try ConfigurationExchange.watchCopy(unsupported) }
}

@Test func exchangeChecksTargetOSAndSchemaReference() throws {
    var task = ConfigurationExchange.template()
    task.data.selections = [MetricSelection(typeIdentifier: "HKQuantityTypeIdentifierHeartRateVariabilityRMSSD", unit: "ms")]
    #expect(!ConfigurationExchange.inspect(try exchangeData(task), systemMajorVersion: 18).valid)
    #expect(ConfigurationExchange.inspect(try exchangeData(task), systemMajorVersion: 27).valid)
    let schema = try #require(JSONSerialization.jsonObject(with: ConfigurationExchange.schema()) as? [String: Any])
    #expect(schema["oneOf"] != nil)
    let reference = try #require(JSONSerialization.jsonObject(with: ConfigurationExchange.reference()) as? [String: Any])
    #expect(reference["schema"] != nil && reference["catalog"] != nil && reference["examples"] != nil)
}

@Test func exchangeAcceptsEveryOptionalFieldAndLegacyNullDevice() throws {
    var task = ConfigurationExchange.template()
    let workout = try #require(MetricCatalog.bundled.metrics.first { $0.family == .workout })
    task.data.family = .workout
    task.data.selections = [workout.selection]
    task.data.selections[0].statistics = []
    task.data.workoutOptions = WorkoutOptions()
    task.range.days = 3
    task.range.start = "2026-10-01T00:00:00Z"
    task.range.end = "2026-10-02T00:00:00Z"
    task.export.deletionPolicy = .omit
    task.export.heaDataType = .automatic
    task.destination.credentialRef = "local-ref"
    task.destination.secretHeaders = ["X-Token": "local-other-ref"]
    task.destination.requiredSecretHeaders = ["X-Token"]
    task.execution.periodicPolling = true
    task.execution.reminder = ReminderSettings()
    task.execution.notifyOnFailure = true
    task.execution.notifyOnSuccess = false
    #expect(ConfigurationExchange.inspect(try exchangeData(task)).valid)
    for nullDevice in [false, true] {
        let data = try exchangeData(task) { object in
            if nullDevice { object["device"] = NSNull() } else { object.removeValue(forKey: "device") }
            var destination = object["destination"] as! [String: Any]
            for key in ["credentialRef", "credentialHeader", "credentialPrefix", "secretHeaders", "requiredSecretHeaders"] { destination[key] = NSNull() }
            object["destination"] = destination
            var execution = object["execution"] as! [String: Any]
            for key in ["periodicPolling", "reminder", "notifyOnFailure", "notifyOnSuccess"] { execution[key] = NSNull() }
            object["execution"] = execution
            var data = object["data"] as! [String: Any]
            data["workoutOptions"] = NSNull()
            object["data"] = data
        }
        let report = ConfigurationExchange.inspect(data)
        #expect(report.valid)
        #expect(report.tasks.first?.device == .iPhone)
    }
}

@Test func exchangeRejectsForgedValidInspectionAndWatchOversizedTask() throws {
    var task = ConfigurationExchange.template()
    task.destination.url = "http://example.com"
    let forged: [String: Any] = ["valid": true, "tasks": [try JSONSerialization.jsonObject(with: exchangeData(task))], "issues": []]
    let inspection = try JSONDecoder().decode(ConfigurationInspection.self, from: JSONSerialization.data(withJSONObject: forged))
    #expect(throws: ConfigurationError.self) { try ConfigurationExchange.copiesForImport(inspection) }
    task = ConfigurationExchange.template()
    task.name = String(repeating: "x", count: 61_440)
    #expect(throws: ConfigurationError.self) { try ConfigurationExchange.watchCopy(task) }
}

@Test func exchangeTemplatesRequestPeriodicPollingAndWatchInspectionChecksCombinedSnapshot() throws {
    #expect(ConfigurationExchange.template().execution.periodicPolling == true)
    var first = ConfigurationExchange.template(device: .watch)
    first.destination.requiredSecretHeaders = ["Authorization"]
    #expect(ConfigurationExchange.inspect(try exchangeData(first)).valid)
    first.destination.requiredSecretHeaders = ["Invalid Header"]
    #expect(!ConfigurationExchange.inspect(try exchangeData(first)).valid)
    first.destination.requiredSecretHeaders = nil
    first.name = String(repeating: "x", count: 32_000)
    var second = first
    second.id = UUID()
    let report = ConfigurationExchange.inspect(try ConfigurationExchange.export([first, second]))
    #expect(!report.valid)
    #expect(report.issues.contains { $0.code == "watch_snapshot" && $0.path == "/tasks" })
}

@Test func portableLegacyCredentialReferenceKeepsAuthorizationRequirement() {
    var task = AutomationConfig()
    task.destination.credentialRef = "private-device-reference"
    let copy = ConfigurationCodec.portable(task)
    #expect(copy.destination.credentialHeader == "Authorization")
    #expect(copy.destination.credentialRef == nil)
    #expect(!copy.executionDestinationIssues.isEmpty)
}

@Test(arguments: ["credentialHeader", "secretHeaders", "requiredSecretHeaders"], ["X-Custom", "x-CUSTOM"])
func exchangeStripsExplicitAuthenticationHeadersIgnoringCaseAndKeepsWatchCopiesValid(source: String, headerName: String) throws {
    var task = ConfigurationExchange.template()
    task.destination.headers = [headerName: "synthetic-secret", "X-Environment": "test"]
    switch source {
    case "credentialHeader": task.destination.credentialHeader = "X-Custom"
    case "secretHeaders": task.destination.secretHeaders = ["X-Custom": "synthetic-reference"]
    default: task.destination.requiredSecretHeaders = ["X-Custom"]
    }
    let report = ConfigurationExchange.inspect(try exchangeData(task))
    #expect(report.valid)
    let copy = try #require(report.tasks.first)
    #expect(copy.destination.headers == ["X-Environment": "test"])
    #expect(copy.destination.secretHeaders == nil)
    let text = String(decoding: try JSONEncoder().encode(report), as: UTF8.self)
    #expect(!text.contains("synthetic-secret") && !text.contains("synthetic-reference"))
    let exported = String(decoding: try ConfigurationExchange.export([task]), as: UTF8.self)
    #expect(!exported.contains("synthetic-secret") && !exported.contains("synthetic-reference"))
    let watch = try ConfigurationExchange.watchCopy(task)
    #expect(watch.destination.headers == ["X-Environment": "test"])
    #expect(throws: Never.self) { try WatchConfigurationSnapshot(tasks: [watch]) }
}

@Test func portableAuthenticationRequirementsAreUniqueIgnoringCase() throws {
    var task = ConfigurationExchange.template()
    task.destination.credentialHeader = "X-Custom"
    task.destination.requiredSecretHeaders = ["x-custom", "X-SECOND", "x-second"]
    task.destination.secretHeaders = ["X-CUSTOM": "synthetic-reference", "X-Second": "second-reference"]
    task.destination.headers = ["x-Custom": "synthetic-secret", "x-second": "second-secret", "X-Environment": "test"]
    let portable = ConfigurationCodec.portable(task)
    #expect(portable.destination.requiredSecretHeaders == ["X-SECOND"])
    #expect(portable.destination.headers == ["X-Environment": "test"])
    #expect(ConfigurationCodec.portable(portable) == portable)
    #expect(throws: Never.self) { try ConfigurationExchange.watchCopy(task) }
}
