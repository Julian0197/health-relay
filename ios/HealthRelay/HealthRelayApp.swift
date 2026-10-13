import SwiftUI

@main
struct HealthRelayApp: App {
    @UIApplicationDelegateAdaptor(HealthRelayAppDelegate.self) private var delegate
    @State private var store = AutomationStore.shared
    @Environment(\.scenePhase) private var phase
    var body: some Scene {
        WindowGroup {
            AutomationListView(store: store).tint(.teal)
                .onChange(of: phase, initial: true) { _, new in
                    store.setForegroundActive(new == .active)
                }
        }
    }
}
