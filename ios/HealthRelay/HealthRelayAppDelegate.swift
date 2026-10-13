import UIKit

final class HealthRelayAppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        AutomationStore.shared.registerBackgroundRefresh()
        AutomationStore.shared.startBackgroundServices()
        #if DEBUG
        AutomationStore.shared.reportObserverStartup("didFinishLaunching")
        #endif
        return true
    }

    func applicationProtectedDataDidBecomeAvailable(_ application: UIApplication) {
        AutomationStore.shared.protectedDataDidBecomeAvailable()
    }
}
