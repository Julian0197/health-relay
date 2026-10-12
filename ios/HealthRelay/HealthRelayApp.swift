import SwiftUI

@main
struct HealthRelayApp: App {
    @State private var store = AutomationStore()
    var body: some Scene {
        WindowGroup { AutomationListView(store: store).tint(.teal) }
    }
}
