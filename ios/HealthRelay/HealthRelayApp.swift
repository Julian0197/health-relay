import SwiftUI

@main
struct HealthRelayApp: App {
    @State private var store = AutomationStore.shared
    @Environment(\.scenePhase) private var phase
    var body: some Scene {
        WindowGroup {
            AutomationListView(store: store).tint(.teal)
                .task { await store.configureObservers() }
                .onChange(of: phase) { _, new in
                    if new == .active { Task { await store.runDue() } }
                }
        }
    }
}
