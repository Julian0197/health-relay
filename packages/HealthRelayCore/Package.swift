// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "HealthRelayCore",
    platforms: [.iOS(.v18), .macOS(.v14), .watchOS(.v11)],
    products: [
        .library(name: "HealthRelayCore", targets: ["HealthRelayCore"]),
        .executable(name: "healthrelay-config", targets: ["HealthRelayConfigCLI"])
    ],
    targets: [
        .target(name: "HealthRelayCore", resources: [.process("Resources")]),
        .executableTarget(name: "HealthRelayConfigCLI", dependencies: ["HealthRelayCore"]),
        .testTarget(name: "HealthRelayCoreTests", dependencies: ["HealthRelayCore"], resources: [.copy("Fixtures")])
    ]
)
