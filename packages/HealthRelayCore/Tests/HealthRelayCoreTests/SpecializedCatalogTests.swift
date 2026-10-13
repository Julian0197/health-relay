import Testing
@testable import HealthRelayCore

@Test func specializedCatalogUsesPhysicalTypesAndAvailability() throws {
    let catalog = MetricCatalog.bundled
    #expect(catalog.metrics.filter { $0.family == .quantity }.count == 121)
    #expect(catalog.metrics.filter { $0.family == .category }.count == 72)
    for (id, ios, watch) in [("HKDataTypeIdentifierElectrocardiogram", 14, 7), ("HKDataTypeStateOfMind", 18, 11), ("HKMedicationDoseEventTypeIdentifierMedicationDoseEvent", 26, 26)] {
        let descriptor = try #require(catalog.metric(id))
        #expect(descriptor.family.rawValue == "special")
        #expect(descriptor.minimumIOS == ios)
        #expect(descriptor.minimumWatchOS == watch)
        #expect(descriptor.units.isEmpty && descriptor.statistics.isEmpty)
        #expect(catalog.search("", family: .healthMetrics).contains(descriptor))
        var task = AutomationConfig(); task.destination.url = "https://example.com/ingest"
        task.data.selections = [descriptor.selection]
        #expect(task.validationIssues(systemMajorVersion: ios).isEmpty)
        #expect(!task.validationIssues(systemMajorVersion: ios - 1).isEmpty)
        #expect(task.validationIssues(systemMajorVersion: watch, device: .watch).isEmpty)
        #expect(!task.validationIssues(systemMajorVersion: watch - 1, device: .watch).isEmpty)
        #expect(!task.supportsAggregation)
        task.data.selections[0].unit = "count"
        #expect(!task.validationIssues(systemMajorVersion: ios).isEmpty)
    }
    #expect(catalog.metric("HKDataTypeUserAnnotatedMedicationConcept") == nil)
}
