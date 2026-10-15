import Foundation
import HealthRelayCore

private struct CommandError: Error {
    let code: String
    let message: String
}

private struct Failure: Encodable {
    struct Issue: Encodable {
        let severity = "error"
        let code: String
        let path = ""
        let message: String
    }
    let valid = false
    let tasks: [AutomationConfig] = []
    let issues: [Issue]
}

private struct Options {
    var device = ExecutionDevice.iPhone
    var systemMajorVersion = 27
    var input: String?
    init(command: String, arguments: [String]) throws {
        var index = 0
        var seen: Set<String> = []
        while index < arguments.count {
            let argument = arguments[index]
            switch argument {
            case "--device" where ["catalog", "template"].contains(command):
                guard seen.insert(argument).inserted, index + 1 < arguments.count,
                      let value = ExecutionDevice(rawValue: arguments[index + 1]) else { throw usage() }
                device = value; index += 2
            case "--os-major" where ["catalog", "validate", "watch"].contains(command):
                guard seen.insert(argument).inserted, index + 1 < arguments.count,
                      let value = Int(arguments[index + 1]), value > 0 else { throw usage() }
                systemMajorVersion = value; index += 2
            default:
                guard ["validate", "watch"].contains(command), input == nil,
                      argument == "-" || !argument.hasPrefix("--") else { throw usage() }
                input = argument; index += 1
            }
        }
        if ["validate", "watch"].contains(command), input == nil { throw usage() }
    }
}

private func usage() -> CommandError {
    CommandError(code: "usage", message: "Commands: schema; reference; catalog [--device iPhone|watch] [--os-major N]; template [--device iPhone|watch]; validate FILE|- [--os-major N]; watch FILE|- [--os-major N].")
}

private func readInput(_ source: String) throws -> Data {
    let handle: FileHandle
    do { handle = source == "-" ? .standardInput : try FileHandle(forReadingFrom: URL(fileURLWithPath: source)) }
    catch { throw CommandError(code: "input_read", message: "Cannot open the local configuration file.") }
    defer { if source != "-" { try? handle.close() } }
    var data = Data()
    do {
        while data.count <= ConfigurationExchange.maximumInputBytes {
            let remaining = ConfigurationExchange.maximumInputBytes + 1 - data.count
            guard let chunk = try handle.read(upToCount: min(65_536, remaining)), !chunk.isEmpty else { return data }
            data.append(chunk)
        }
    } catch { throw CommandError(code: "input_read", message: "Cannot read the local configuration input.") }
    throw CommandError(code: "input_too_large", message: "Configuration input exceeds 1 MiB.")
}

private func encoded<T: Encodable>(_ value: T) throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    return try encoder.encode(value)
}

private func output(_ data: Data) {
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
}

do {
    let arguments = Array(CommandLine.arguments.dropFirst())
    guard let command = arguments.first, ["schema", "reference", "catalog", "template", "validate", "watch"].contains(command) else { throw usage() }
    let options = try Options(command: command, arguments: Array(arguments.dropFirst()))
    switch command {
    case "schema": output(try ConfigurationExchange.schema())
    case "reference": output(try ConfigurationExchange.reference())
    case "catalog":
        struct Catalog: Encodable { let device: ExecutionDevice; let systemMajorVersion: Int; let metrics: [MetricDescriptor] }
        let metrics = MetricCatalog.bundled.metrics.filter {
            let minimum = options.device == .watch ? $0.minimumWatchOS : $0.minimumIOS
            return minimum.map { $0 <= options.systemMajorVersion } ?? false
        }
        output(try encoded(Catalog(device: options.device, systemMajorVersion: options.systemMajorVersion, metrics: metrics)))
    case "template": output(try ConfigurationCodec.export(ConfigurationExchange.template(device: options.device)))
    case "validate", "watch":
        // For conversion, --os-major describes the destination Watch, not the source iPhone.
        let sourceVersion = command == "watch" ? 27 : options.systemMajorVersion
        let report = ConfigurationExchange.inspect(try readInput(options.input!), systemMajorVersion: sourceVersion)
        guard report.valid else { output(try encoded(report)); exit(2) }
        if command == "validate" { output(try encoded(report)) }
        else {
            let copies = try report.tasks.map(ConfigurationExchange.watchCopy)
            let snapshot = try WatchConfigurationSnapshot(tasks: copies)
            try snapshot.validate(systemMajorVersion: options.systemMajorVersion)
            output(try ConfigurationExchange.export(copies))
        }
    default: throw usage()
    }
} catch {
    let failure = (error as? CommandError) ?? CommandError(code: "invalid_configuration", message: "Configuration cannot be converted. Check target-device capabilities, authentication header names, and the combined Watch snapshot limit of 60 KiB.")
    if let data = try? encoded(Failure(issues: [.init(code: failure.code, message: failure.message)])) { output(data) }
    exit(2)
}
