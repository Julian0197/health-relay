// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "HealthRelayCore",
    platforms: [.iOS(.v18), .macOS(.v14)],
    products: [.library(name: "HealthRelayCore", targets: ["HealthRelayCore"])],
    targets: [
        .target(name: "HealthRelayCore", resources: [.process("Resources")]),
        .testTarget(name: "HealthRelayCoreTests", dependencies: ["HealthRelayCore"], resources: [.copy("Fixtures")])
    ]
)
