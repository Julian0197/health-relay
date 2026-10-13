import Foundation

/// Shared eligibility for foreground wakes, background requests and HealthKit changes.
public enum AutomationSchedule {
    public static func nextDate(_ settings: ExecutionSettings, state: SyncState,
                                dirty: Bool = false, foregroundCheck: Bool = false, periodicCheck: Bool = true,
                                backfill: Bool = false, now: Date) -> Date? {
        if let pending = state.pending {
            return pending.automaticRetry ? pending.nextAttempt ?? now : nil
        }
        if state.nextSelectionID != nil || backfill {
            // A read failure has no pending HTTP request, but still needs backoff.
            let delay: TimeInterval = state.logs.first?.state == .failed ? 300 : 1
            return state.lastAttempt?.addingTimeInterval(delay) ?? now
        }
        guard dirty || (periodicCheck && settings.periodicPolling == true) || (foregroundCheck && settings.onForeground) else { return nil }
        return state.lastAttempt?.addingTimeInterval(Double(settings.minimumIntervalSeconds)) ?? now
    }
}
