import Foundation
import Testing
@testable import HealthRelayCore

private func fixture(_ name: String) throws -> Data {
    try Data(contentsOf: #require(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures")))
}

private func modifiedFixture(_ change: (inout [String: Any]) -> Void) throws -> Data {
    var object = try #require(JSONSerialization.jsonObject(with: fixture("task.raw")) as? [String: Any])
    change(&object)
    return try JSONSerialization.data(withJSONObject: object)
}

@Test func rejectsFutureSchema() throws {
    let data = try modifiedFixture { $0["schemaVersion"] = 99 }
    #expect(throws: ConfigurationError.self) { try ConfigurationCodec.decode(data) }
}

@Test func importAlwaysDisablesTasks() throws {
    let data = try modifiedFixture { $0["enabled"] = true }
    #expect(try ConfigurationCodec.decode(data).enabled == false)
}

@Test func readsPublishedExamplesAndRoundTrips() throws {
    for name in ["task.raw", "task.daily"] {
        let config = try ConfigurationCodec.decode(fixture(name))
        #expect(config.data.selections.count == 2)
        let roundTrip = try ConfigurationCodec.decode(ConfigurationCodec.export(config))
        #expect(roundTrip == config)
    }
}

@Test func exportRemovesSensitiveHeadersAndCredentialReferences() throws {
    var config = try ConfigurationCodec.decode(fixture("task.raw"))
    config.destination.headers = ["Authorization": "Bearer test-secret", "X-API-Key": "another-secret", "X-Environment": "test"]
    config.destination.credentialRef = "private-device-reference"
    config.destination.secretHeaders = ["X-Private-Header": "second-private-reference"]
    config.enabled = true
    let exported = try ConfigurationCodec.export(config)
    let text = String(decoding: exported, as: UTF8.self)
    #expect(!text.contains("test-secret"))
    #expect(!text.contains("another-secret"))
    #expect(!text.contains("private-device-reference"))
    #expect(!text.contains("second-private-reference"))
    let imported = try ConfigurationCodec.decode(exported)
    #expect(imported.enabled == false)
    #expect(imported.destination.headers["X-Environment"] == "test")
}

@Test func rejectsReservedHeadersIgnoringCase() throws {
    let config = try ConfigurationCodec.decode(fixture("task.raw"))
    var changed = config
    changed.destination.headers = ["content-type": "text/plain"]
    #expect(!changed.validationIssues().isEmpty)
}

@Test func rejectsInvalidWindowAndURL() throws {
    var config = try ConfigurationCodec.decode(fixture("task.raw"))
    config.range = DateRange(mode: .custom, start: "2026-01-02T00:00:00Z", end: "2026-01-01T00:00:00Z")
    config.destination.url = "https://user:password@example.com/ingest"
    #expect(config.validationIssues().count >= 2)
}

@Test func rejectsRawWithGroupingAndImpossibleStatistics() throws {
    var config = try ConfigurationCodec.decode(fixture("task.raw"))
    config.export.grouping = .minutes
    #expect(!config.validationIssues().isEmpty)
    config.export.mode = .aggregate
    config.export.statistics = [.sum]
    #expect(!config.validationIssues().isEmpty)
}

@Test func availabilityAndFamilyComeFromCatalog() throws {
    var config = try ConfigurationCodec.decode(fixture("task.raw"))
    config.data.selections = [MetricSelection(typeIdentifier: "HKQuantityTypeIdentifierHeartRateVariabilityRMSSD", unit: "ms")]
    #expect(!config.validationIssues(systemMajorVersion: 18).isEmpty)
    #expect(config.validationIssues(systemMajorVersion: 27).isEmpty)
    config.data.family = .category
    #expect(!config.validationIssues(systemMajorVersion: 27).isEmpty)
}

@Test func rejectsWrongUnitAndUnknownTypes() throws {
    var config = try ConfigurationCodec.decode(fixture("task.raw"))
    config.data.selections[0].unit = "bpm"
    #expect(!config.validationIssues().isEmpty)
    config.data.selections = [MetricSelection(typeIdentifier: "MadeUpHealthMetric", unit: "count")]
    #expect(!config.validationIssues().isEmpty)
}

@Test func catalogIsBroadAndSupportsSearch() throws {
    let catalog = try MetricCatalog.load()
    #expect(catalog.metrics.filter { $0.family == .quantity }.count == 121)
    #expect(catalog.metrics.filter { $0.family == .category }.count == 72)
    #expect(catalog.search("营养", family: .quantity).count > 10)
    #expect(catalog.search("恢复 HRV", family: .quantity).contains { $0.id == "HKQuantityTypeIdentifierHeartRateVariabilityRMSSD" })
}

@Test func duplicationDoesNotReuseSecretHeaderReferences() {
    var task = AutomationConfig.newTask()
    task.destination.secretHeaders = ["X-Private-Header": "private-reference"]
    #expect(task.duplicated().destination.secretHeaders == nil)
}

@Test func rejectsDuplicateMetricsAndHeaderLineBreaks() throws {
    var config = try ConfigurationCodec.decode(fixture("task.raw"))
    config.data.selections.append(config.data.selections[0])
    config.destination.headers["X-Test"] = "hello\r\nInjected: value"
    #expect(config.validationIssues().count >= 2)
}

@Test func portableConfigurationKeepsSecretHeaderNamesForRebinding() throws {
    var config = try ConfigurationCodec.decode(fixture("task.raw"))
    config.destination.secretHeaders = ["X-Custom-Credential": "private-reference"]
    let imported = try ConfigurationCodec.decode(ConfigurationCodec.export(config))
    #expect(imported.destination.requiredSecretHeaders == ["X-Custom-Credential"])
    #expect(imported.destination.secretHeaders == nil)
}

@Test func rejectsCredentialPrefixLineBreaks() throws {
    var config = try ConfigurationCodec.decode(fixture("task.raw"))
    config.destination.credentialHeader = "Authorization"
    config.destination.credentialPrefix = "Bearer \r\nInjected: value"
    #expect(!config.validationIssues().isEmpty)
}

@Test func acceptsConfiguredExportProfilesAndRejectsUnknownFormat() throws {
    var config = try ConfigurationCodec.decode(fixture("task.raw"))
    for format in ["healthrelay.v1", "hea.v1", "hea.v2", "csv", "markdown"] {
        config.export.format = format
        #expect(config.validationIssues().isEmpty)
    }
    config.export.format = "unknown-format"
    #expect(!config.validationIssues().isEmpty)
}

@Test func oneHealthMetricsTaskCanContainQuantitiesAndCategoryRecords() throws {
    var config = try ConfigurationCodec.decode(fixture("task.raw"))
    config.data = AutomationConfig.newTask().data
    config.data.selections = [
        MetricSelection(typeIdentifier: "HKQuantityTypeIdentifierHeartRate", unit: "count/min"),
        MetricSelection(typeIdentifier: "HKCategoryTypeIdentifierSleepAnalysis")
    ]
    #expect(config.validationIssues().isEmpty)
    config.export.mode = .aggregate
    config.export.grouping = .days
    config.export.statistics = [.sum]
    #expect(!config.validationIssues().isEmpty)
}
