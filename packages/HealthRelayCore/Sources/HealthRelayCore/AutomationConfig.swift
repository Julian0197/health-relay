import Foundation

public enum ExecutionDevice: String, Codable, CaseIterable, Sendable {
    case iPhone, watch
    public var title: String { self == .iPhone ? "iPhone" : "Apple Watch" }
}

public enum DataFamily: String, Codable, CaseIterable, Sendable {
    case healthMetrics, quantity, category, correlation, workout
    public var title: String {
        switch self {
        case .healthMetrics: "健康指标（全部）"
        case .quantity: "数量指标"
        case .category: "分类记录"
        case .correlation: "关联记录"
        case .workout: "锻炼"
        }
    }
}

public struct MetricSelection: Codable, Equatable, Identifiable, Sendable {
    public var typeIdentifier: String
    public var unit: String?
    public var sources: [String]
    public var statistics: [ExportSettings.Statistic]?
    public var id: String { typeIdentifier }
    public init(typeIdentifier: String, unit: String? = nil, sources: [String] = []) {
        self.typeIdentifier = typeIdentifier; self.unit = unit; self.sources = sources
    }
}

public struct DataSelection: Codable, Equatable, Sendable {
    public var family: DataFamily = .healthMetrics
    public var selections: [MetricSelection] = []
    public var excludedSources: [String] = []
    public var workoutOptions: WorkoutOptions?
    public init() {}
}

public struct WorkoutOptions: Codable, Equatable, Sendable {
    public var includeRoutes = false
    public var includeMetrics = false
    public var metricGrouping = "minutes"
    public init() {}
}

public struct DateRange: Codable, Equatable, Sendable {
    public enum Mode: String, Codable, CaseIterable, Sendable {
        case incremental, today, yesterday, pastDays, previousDays, defaultRange, custom
        public var title: String {
            switch self {
            case .incremental: "自上次同步"
            case .today: "今天"
            case .yesterday: "昨天"
            case .pastDays: "过去 N 天（含今天）"
            case .previousDays: "完整前 N 天"
            case .defaultRange: "昨天至今"
            case .custom: "自定义"
            }
        }
    }
    public var mode: Mode
    public var bootstrapDays: Int?
    public var days: Int?
    public var start: String?
    public var end: String?
    public init(mode: Mode = .incremental, bootstrapDays: Int? = 7, days: Int? = nil, start: String? = nil, end: String? = nil) {
        self.mode = mode; self.bootstrapDays = bootstrapDays; self.days = days; self.start = start; self.end = end
    }
}

public struct ExportSettings: Codable, Equatable, Sendable {
    public enum Mode: String, Codable, CaseIterable, Sendable { case raw, aggregate }
    public enum Grouping: String, Codable, CaseIterable, Sendable {
        case none, seconds, minutes, hours, days, weeks, months, years
        public var title: String {
            switch self {
            case .none: "不分组"
            case .seconds: "秒"
            case .minutes: "分钟"
            case .hours: "小时"
            case .days: "天"
            case .weeks: "周"
            case .months: "月"
            case .years: "年"
            }
        }
    }
    public enum Statistic: String, Codable, CaseIterable, Sendable { case sum, average, minimum, maximum }
    public enum DeletionPolicy: String, Codable, CaseIterable, Sendable { case reject, omit }
    public var deletionPolicy: DeletionPolicy?
    public var format = "healthrelay.v1"
    public var mode: Mode = .raw
    public var grouping: Grouping = .none
    public var statistics: [Statistic] = []
    public var timeZone = TimeZone.current.identifier
    public init() {}
}

public struct HTTPDestination: Codable, Equatable, Sendable {
    public enum Acknowledgement: String, Codable, CaseIterable, Sendable { case receipt, http2xx }
    public var kind = "http"
    public var url = ""
    public var method = "POST"
    public var headers: [String: String] = [:]
    public var credentialRef: String?
    public var credentialHeader: String?
    public var credentialPrefix: String?
    public var secretHeaders: [String: String]?
    public var requiredSecretHeaders: [String]?
    public var timeoutSeconds = 30
    public var acknowledgement: Acknowledgement = .http2xx
    public init() {}
}

public struct ExecutionSettings: Codable, Equatable, Sendable {
    public var onDataChange = true
    public var onForeground = true
    public var periodicPolling: Bool?
    public var minimumIntervalSeconds = 1800
    public var batchMaxRecords = 500
    public var batchMaxBytes = 1_048_576
    public var notifyOnFailure: Bool?
    public var notifyOnSuccess: Bool?
    public init() {}
}

public struct AutomationConfig: Codable, Equatable, Identifiable, Sendable {
    public var schemaVersion = 1
    public var device: ExecutionDevice = .iPhone
    public var id: UUID
    public var revision = 1
    public var name = "新自动化"
    public var enabled = false
    public var data = DataSelection()
    public var range = DateRange()
    public var export = ExportSettings()
    public var destination = HTTPDestination()
    public var execution = ExecutionSettings()
    public init(id: UUID = UUID()) { self.id = id }
    private enum CodingKeys: String, CodingKey { case schemaVersion, device, id, revision, name, enabled, data, range, export, destination, execution }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try values.decode(Int.self, forKey: .schemaVersion)
        device = try values.decodeIfPresent(ExecutionDevice.self, forKey: .device) ?? .iPhone
        id = try values.decode(UUID.self, forKey: .id)
        revision = try values.decode(Int.self, forKey: .revision)
        name = try values.decode(String.self, forKey: .name)
        enabled = try values.decode(Bool.self, forKey: .enabled)
        data = try values.decode(DataSelection.self, forKey: .data)
        range = try values.decode(DateRange.self, forKey: .range)
        export = try values.decode(ExportSettings.self, forKey: .export)
        destination = try values.decode(HTTPDestination.self, forKey: .destination)
        execution = try values.decode(ExecutionSettings.self, forKey: .execution)
    }
    public static func newTask() -> Self { Self() }
    public func duplicated() -> Self {
        var copy = self
        copy.id = UUID(); copy.name += " 副本"; copy.revision = 1; copy.enabled = false
        copy.destination.credentialRef = nil
        let needed = Set(copy.destination.requiredSecretHeaders ?? []).union((copy.destination.secretHeaders ?? [:]).keys)
        copy.destination.requiredSecretHeaders = needed.isEmpty ? nil : needed.sorted()
        copy.destination.secretHeaders = nil
        return copy
    }
    public var allowedStatistics: [ExportSettings.Statistic] {
        let descriptors = data.selections.compactMap { MetricCatalog.bundled.metric($0.id) }
        guard let first = descriptors.first, descriptors.count == data.selections.count else { return [] }
        return first.statistics.filter { option in descriptors.allSatisfy { $0.statistics.contains(option) } }
    }

    public func statistics(for selection: MetricSelection) -> [ExportSettings.Statistic] {
        if let chosen = selection.statistics { return chosen }
        if !export.statistics.isEmpty { return export.statistics }
        return MetricCatalog.bundled.metric(selection.id)?.statistics ?? []
    }
    public var supportsAggregation: Bool {
        !data.selections.isEmpty && data.selections.allSatisfy {
            $0.id == "HKCategoryTypeIdentifierSleepAnalysis" || MetricCatalog.bundled.metric($0.id)?.family == .quantity
        }
    }

    public func validationIssues(systemMajorVersion: Int = 27, device platform: ExecutionDevice = .iPhone) -> [String] {
        var issues: [String] = []
        if schemaVersion != 1 { issues.append("不支持的配置版本：\(schemaVersion)") }
        if revision < 1 { issues.append("配置 revision 必须大于 0") }
        if name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { issues.append("请输入任务名称") }
        if data.selections.isEmpty { issues.append("请选择至少一个数据指标") }
        if Set(data.selections.map(\.id)).count != data.selections.count { issues.append("同一指标不能重复选择") }
        for selection in data.selections {
            guard let metric = MetricCatalog.bundled.metric(selection.id) else {
                issues.append("未知指标：\(selection.id)"); continue
            }
            let matches = metric.family == data.family ||
                (data.family == .healthMetrics && [.quantity, .category, .correlation].contains(metric.family))
            if !matches { issues.append("\(metric.title) 不属于当前数据类型") }
            if platform == .watch {
                if let minimum = metric.minimumWatchOS {
                    if minimum > systemMajorVersion { issues.append("\(metric.title) 需要 watchOS \(minimum) 或更新版本") }
                } else { issues.append("\(metric.title) 不支持 watchOS") }
            } else if metric.minimumIOS > systemMajorVersion { issues.append("\(metric.title) 需要 iOS \(metric.minimumIOS) 或更新版本") }
            if metric.family == .quantity && !metric.units.contains(selection.unit ?? "") { issues.append("\(metric.title) 的单位无效") }
            if metric.family != .quantity && selection.unit != nil { issues.append("\(metric.title) 不支持数量单位") }
        }
        switch range.mode {
        case .incremental:
            if !(1...3650).contains(range.bootstrapDays ?? 0) { issues.append("首次读取范围须为 1–3650 天") }
        case .pastDays, .previousDays:
            if !(1...3650).contains(range.days ?? 0) { issues.append("日期范围须为 1–3650 天") }
        case .custom:
            if let start = Self.parseDate(range.start), let end = Self.parseDate(range.end), start < end {} else {
                issues.append("自定义日期必须有效，且结束时间晚于开始时间")
            }
        case .today, .yesterday, .defaultRange: break
        }
        if TimeZone(identifier: export.timeZone) == nil { issues.append("时区无效") }
        if !["healthrelay.v1", "hea.v1", "hea.v2", "hea.csv", "csv", "markdown"].contains(export.format) { issues.append("未知导出格式") }
        if let options = data.workoutOptions {
            if data.family != .workout { issues.append("锻炼选项仅适用于锻炼数据") }
            if !["seconds", "minutes"].contains(options.metricGrouping) { issues.append("锻炼曲线分组须为秒或分钟") }
        }
        if export.mode == .raw {
            if export.grouping != .none || !export.statistics.isEmpty { issues.append("明细导出不能设置汇总分组或统计方法") }
        } else {
            if export.grouping == .none { issues.append("请选择汇总时间分组") }
            for selection in data.selections {
                guard let metric = MetricCatalog.bundled.metric(selection.id) else { continue }
                if selection.id == "HKCategoryTypeIdentifierSleepAnalysis" { continue }
                let chosen = statistics(for: selection)
                if metric.family != .quantity || chosen.isEmpty || !chosen.allSatisfy({ metric.statistics.contains($0) }) {
                    issues.append("\(metric.title) 不支持所选汇总统计")
                }
            }
        }
        if let url = URLComponents(string: destination.url), url.scheme == "https", let host = url.host, !host.isEmpty,
           url.user == nil, url.password == nil, url.fragment == nil {} else {
            issues.append("请输入完整 HTTPS 接口地址，不包含账号密码或 URL 片段")
        }
        if destination.kind != "http" || destination.method != "POST" { issues.append("当前版本仅支持 HTTP POST 目的地") }
        if !(5...300).contains(destination.timeoutSeconds) { issues.append("请求超时须为 5–300 秒") }
        let keys = destination.headers.keys.map { $0.lowercased() }
        if Set(keys).count != keys.count { issues.append("Header 名称不能重复（不区分大小写）") }
        let reserved = ["content-type", "content-length", "host", "idempotency-key"]
        for (name, value) in destination.headers {
            if !Self.isValidHeaderName(name) || Self.containsHeaderLineBreak(value) { issues.append("Header 名称或内容无效") }
            if reserved.contains(name.lowercased()) { issues.append("\(name) 由导出器管理，请勿覆盖") }
        }
        if let name = destination.credentialHeader, !Self.isValidHeaderName(name) || reserved.contains(name.lowercased()) {
            issues.append("认证 Header 名称无效")
        }
        if Self.containsHeaderLineBreak(destination.credentialPrefix ?? "") { issues.append("认证前缀不能包含换行") }
        if !(60...604800).contains(execution.minimumIntervalSeconds) { issues.append("期望间隔须为 1 分钟至 7 天") }
        if !(1...5000).contains(execution.batchMaxRecords) { issues.append("每批记录数须为 1–5000") }
        if !(1024...10_485_760).contains(execution.batchMaxBytes) { issues.append("每批大小须为 1 KiB–10 MiB") }
        return issues
    }

    public static func parseDate(_ text: String?) -> Date? {
        guard let text else { return nil }
        let formatter = ISO8601DateFormatter()
        if let date = formatter.date(from: text) { return date }
        formatter.formatOptions.insert(.withFractionalSeconds)
        return formatter.date(from: text)
    }

    public static func isValidHeaderName(_ name: String) -> Bool {
        name.range(of: "^[!#$%&'*+.^_`|~0-9A-Za-z-]+$", options: .regularExpression) != nil
    }
    public static func containsHeaderLineBreak(_ value: String) -> Bool {
        value.unicodeScalars.contains { $0.value == 10 || $0.value == 13 }
    }
}

public struct ConfigurationError: Error, LocalizedError, Equatable, Sendable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

public enum ConfigurationCodec {
    public static func isSensitiveHeader(_ name: String) -> Bool {
        let lower = name.lowercased()
        return lower == "authorization" || lower == "cookie" || lower.contains("token") || lower.contains("secret") || lower.contains("key")
    }
    public static func decode(_ data: Data) throws -> AutomationConfig {
        guard data.count <= 1_048_576 else { throw ConfigurationError("配置文件超过 1 MiB") }
        var config = try JSONDecoder().decode(AutomationConfig.self, from: data)
        guard config.schemaVersion == 1 else { throw ConfigurationError("不支持的配置版本：\(config.schemaVersion)") }
        config = portable(config)
        // Import preserves unavailable identifiers for review; the editor prevents saving incompatible tasks.
        return config
    }
    public static func portable(_ config: AutomationConfig) -> AutomationConfig {
        var copy = config
        copy.enabled = false
        let names = Set(copy.destination.requiredSecretHeaders ?? [])
            .union((copy.destination.secretHeaders ?? [:]).keys)
            .union(copy.destination.headers.keys.filter { isSensitiveHeader($0) })
        copy.destination.requiredSecretHeaders = names.isEmpty ? nil : names.sorted()
        copy.destination.headers = copy.destination.headers.filter { !isSensitiveHeader($0.key) }
        copy.destination.credentialRef = nil
        copy.destination.secretHeaders = nil
        return copy
    }
    public static func export(_ config: AutomationConfig) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(portable(config))
    }
}
