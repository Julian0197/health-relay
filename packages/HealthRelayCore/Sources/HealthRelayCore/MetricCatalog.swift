import Foundation

public struct MetricDescriptor: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var title: String
    public var category: String
    public var family: DataFamily
    public var minimumIOS: Int
    public var minimumWatchOS: Int?
    public var units: [String]
    public var statistics: [ExportSettings.Statistic]
    public var selection: MetricSelection {
        MetricSelection(typeIdentifier: id, unit: units.first)
    }
}

public struct MetricCatalog: Codable, Sendable {
    public var metrics: [MetricDescriptor]
    public static func load() throws -> Self {
        guard let url = Bundle.module.url(forResource: "catalog", withExtension: "json") else {
            throw ConfigurationError("应用的指标目录缺失")
        }
        return try JSONDecoder().decode(Self.self, from: Data(contentsOf: url))
    }
    public static let bundled: Self = {
        do { return try load() }
        catch { fatalError("Invalid bundled HealthKit catalog: \(error)") }
    }()
    public func metric(_ id: String) -> MetricDescriptor? { metrics.first { $0.id == id } }
    public func search(_ text: String, family: DataFamily) -> [MetricDescriptor] {
        metrics.filter {
            ($0.family == family || (family == .healthMetrics && [.quantity, .category, .correlation].contains($0.family))) &&
            (text.isEmpty || "\($0.title) \($0.category) \($0.id)".localizedCaseInsensitiveContains(text))
        }.sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
    }
}
