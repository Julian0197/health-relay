import Foundation
import XCTest
@testable import HealthRelayCore

final class HEAGoldenFixtureTests: XCTestCase {
    private struct Fixture: Decodable {
        var name: String
        var format: String
        var timeZone: String
        var records: [HealthRecord]
        var expected: JSONValue
    }

    func testWorkoutV1UsesLegacyFieldNames() throws { try assertFixture("workout-v1") }
    func testWorkoutV2PreservesPauseAdjustedDurationAndEnergySemantics() throws { try assertFixture("workout-v2") }
    func testMissingBasalEnergyDoesNotBecomeZero() throws { try assertFixture("workout-no-basal") }

    func testCorrelatedBloodPressureAndQuantityMetadata() throws { try assertFixture("metrics-special") }

    func testWorkoutV1RouteAndHeartRateProjection() throws { try assertFixture("workout-v1-details") }
    func testWorkoutV2RouteAndHeartRateProjection() throws { try assertFixture("workout-v2-details") }

    private func assertFixture(_ name: String) throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures/hea"))
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        let batch = UploadBatch(task: .newTask(), records: fixture.records)
        let encoded = try BatchEncoder.encode(batch, format: fixture.format, timeZone: fixture.timeZone)
        XCTAssertEqual(encoded.contentType, "application/json")
        let actual = try JSONDecoder().decode(JSONValue.self, from: encoded.body)
        XCTAssertEqual(actual, fixture.expected, fixture.name)
    }
}
