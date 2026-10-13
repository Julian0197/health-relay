import SwiftUI

@main
struct HealthRelayApp: App {
    @State private var store = AutomationStore.shared
    @Environment(\.scenePhase) private var phase
    var body: some Scene {
        WindowGroup {
            AutomationListView(store: store).tint(.teal)
                .task {
                    #if DEBUG && targetEnvironment(simulator)
                    if ProcessInfo.processInfo.arguments.contains("--delay-observer-setup") {
                        try? await Task.sleep(for: .seconds(2))
                    }
                    #endif
                    await store.configureObservers()
                }
                .onChange(of: phase, initial: true) { _, new in
                    store.setForegroundActive(new == .active)
                }
        }
    }
}
