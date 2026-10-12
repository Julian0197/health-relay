import Foundation
import Testing
@testable import HealthRelayCore

@Test func repositoryPersistsEditsAndDuplicatesWithNewIdentity() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let repository = ConfigurationRepository(fileURL: directory.appendingPathComponent("tasks.json"))
    var config = AutomationConfig.newTask()
    config.name = "自己的任务"
    config.data.selections = [MetricSelection(typeIdentifier: "HKQuantityTypeIdentifierStepCount", unit: "count")]
    config.destination.url = "https://api.example.com/ingest"
    try repository.save([config])
    #expect(try repository.load() == [config])
    let duplicate = config.duplicated()
    #expect(duplicate.id != config.id)
    #expect(duplicate.enabled == false)
    #expect(duplicate.revision == 1)
    #expect(duplicate.destination.credentialRef == nil)
    try repository.save([config, duplicate])
    #expect(try repository.load().count == 2)
}

@Test func corruptedStorageIsReportedAndNeverOverwrittenByLoad() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let url = directory.appendingPathComponent("tasks.json")
    let invalid = Data("not json".utf8)
    try invalid.write(to: url)
    let repository = ConfigurationRepository(fileURL: url)
    #expect(throws: (any Error).self) { try repository.load() }
    #expect(try Data(contentsOf: url) == invalid)
}

@Test func repositoryRejectsDuplicateIDsWithoutChangingPreviousFile() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let repository = ConfigurationRepository(fileURL: directory.appendingPathComponent("tasks.json"))
    let config = AutomationConfig.newTask()
    try repository.save([config])
    #expect(throws: (any Error).self) { try repository.save([config, config]) }
    #expect(try repository.load() == [config])
}
