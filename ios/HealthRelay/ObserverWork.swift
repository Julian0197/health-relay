import Foundation

@MainActor enum ObserverWork {
    @discardableResult
    static func start(timeout: Duration = .seconds(25), completion: ObserverCompletion,
                      onTimeout: @escaping @MainActor () -> Void = {},
                      operation: @escaping @MainActor () async -> Void) -> Task<Void, Never> {
        var deadline: Task<Void, Never>?
        let work = Task {
            defer { deadline?.cancel(); completion.call() }
            await operation()
        }
        deadline = Task {
            do { try await Task.sleep(for: timeout) } catch { return }
            work.cancel()
            onTimeout()
            // Do not wait for an occupied coordinator or a slow cancellation handler.
            completion.call()
        }
        return work
    }
}

/// Apple's completion callback is not annotated Sendable; invoke it exactly once
/// after processing finishes or the execution window expires.
final class ObserverCompletion: @unchecked Sendable {
    private let lock = NSLock()
    private var callback: (() -> Void)?
    init(_ callback: @escaping () -> Void) { self.callback = callback }
    func call() {
        lock.lock(); let value = callback; callback = nil; lock.unlock()
        value?()
    }
}
