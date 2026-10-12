import Foundation

/// Main-actor FIFO gate. Cancellation is checked by the caller immediately after acquisition.
@MainActor public final class RunCoordinator {
    private var occupied = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    public init() {}
    public func acquire() async {
        if !occupied { occupied = true; return }
        await withCheckedContinuation { waiters.append($0) }
    }
    public func release() {
        if waiters.isEmpty { occupied = false } else { waiters.removeFirst().resume() }
    }
}
