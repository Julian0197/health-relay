import Foundation
import Security
import HealthRelayCore

struct UploadCompletion: Codable {
    var identity: BatchIdentity
    var status: Int?
    var body: Data
    var retryAfter: String?
    var failure: String?
    var retryable: Bool
    var completedAt: Date?
    var completionID: String?
    var attemptID: String?
}

/// Extra keys preserve compatibility with the original BatchIdentity decoder.
struct UploadAttemptDescription: Codable {
    var taskID: UUID
    var batchID: String
    var fingerprint: String
    var attemptID: String
    var startedAt: Date
    init(identity: BatchIdentity, attemptID: String, startedAt: Date) {
        taskID = identity.taskID; batchID = identity.batchID; fingerprint = identity.fingerprint
        self.attemptID = attemptID; self.startedAt = startedAt
    }
}

/// Delegate callbacks and enqueue/drain operations are serialized on the main queue.
/// The completion file is durable before the app is told it can finish background events.
@MainActor final class BackgroundUploader: NSObject, @preconcurrency URLSessionDataDelegate {
    static let identifier = "org.healthrelay.app.watch.uploads"
    private let sessionIdentifier: String
    private let directory: URL
    private let credentials: CredentialStore
    private var unsavedCompletions: [String: UploadCompletion] = [:]
    private var responses: [Int: Data] = [:]
    private var failures: [Int: String] = [:]
    private var cancellationWaiters: [Int: [CheckedContinuation<Void, Never>]] = [:]
    private var completions: [() -> Void] = []
    var onCompletion: (() -> Void)?
    var onStart: ((BatchIdentity, String, Date) throws -> Void)?
    var storageError: String?
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.background(withIdentifier: sessionIdentifier)
        config.sessionSendsLaunchEvents = true
        config.isDiscretionary = false
        config.httpShouldSetCookies = false
        config.urlCache = nil
        config.timeoutIntervalForResource = 3600
        return URLSession(configuration: config, delegate: self, delegateQueue: .main)
    }()
    init(directory: URL, credentials: CredentialStore, identifier: String = BackgroundUploader.identifier) {
        self.directory = directory; self.credentials = credentials; sessionIdentifier = identifier
        super.init()
    }
    func connect() { _ = session }
    func handleEvents(completion: @escaping () -> Void) { completions.append(completion); connect() }
    nonisolated func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                               completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust,
              let data = try? Data(contentsOf: LocalServerTrust.certificateURL) else {
            completionHandler(.performDefaultHandling, nil); return
        }
        let accepted = LocalServerTrust.evaluate(trust, host: challenge.protectionSpace.host, certificateData: data)
        #if DEBUG
        NSLog("HealthRelay explicit local CA evaluation: %@", accepted ? "accepted" : "rejected")
        #endif
        if accepted {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else { completionHandler(.cancelAuthenticationChallenge, nil) }
    }
    private func prefix(_ id: BatchIdentity) -> String { id.taskID.uuidString + "-" + id.batchID }
    private func file(_ id: BatchIdentity, suffix: String) -> URL { directory.appendingPathComponent(prefix(id) + suffix) }
    private func write(_ data: Data, to url: URL) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try data.write(to: url, options: [.atomic, .completeFileProtection])
    }
    /// Background transfers are opened by nsurlsessiond after the app yields.
    /// The journal remains fully protected; only its staged transport copy uses
    /// the first-unlock class required by the system service.
    static func writeUploadBody(_ data: Data, to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
    func enqueue(task: AutomationConfig, pending: PendingUpload) async throws {
        let issues = task.executionStartIssues(pending: pending, systemMajorVersion: ProcessInfo.processInfo.operatingSystemVersion.majorVersion)
        guard issues.isEmpty else { throw ConfigurationError(issues.joined(separator: "；")) }
        let identity = BatchIdentity(taskID: task.id, batchID: pending.batchID, fingerprint: pending.configurationFingerprint)
        let active = await session.allTasks
        guard !active.contains(where: { BatchIdentity.decodeDescription($0.taskDescription) == identity }) else { return }
        // A persisted callback must be applied before another transmission or query.
        guard !FileManager.default.fileExists(atPath: file(identity, suffix: ".result").path) else { return }
        let bodyFile = file(identity, suffix: ".body")
        try Self.writeUploadBody(pending.body, to: bodyFile)
        var request = try Self.request(task: task, pending: pending, credential: credentials.read)
        request.httpBody = nil
        let startedAt = Date(), attemptID = UUID().uuidString
        let description = String(decoding: try JSONEncoder().encode(UploadAttemptDescription(identity: identity, attemptID: attemptID, startedAt: startedAt)), as: UTF8.self)
        try onStart?(identity, attemptID, startedAt)
        let upload = session.uploadTask(with: request, fromFile: bodyFile)
        upload.taskDescription = description
        upload.resume()
    }
    static func request(task: AutomationConfig, pending: PendingUpload, credential: (String) throws -> String) throws -> URLRequest {
        guard let url = URL(string: task.destination.url), url.scheme == "https", url.host != nil else { throw ConfigurationError("接口必须使用 HTTPS") }
        var request = URLRequest(url: url, timeoutInterval: TimeInterval(task.destination.timeoutSeconds))
        request.httpMethod = "POST"
        for (name, value) in task.destination.headers { request.setValue(value, forHTTPHeaderField: name) }
        for (name, reference) in task.destination.secretHeaders ?? [:] { request.setValue(try credential(reference), forHTTPHeaderField: name) }
        if let reference = task.destination.credentialRef { request.setValue((task.destination.credentialPrefix ?? "") + (try credential(reference)), forHTTPHeaderField: task.destination.credentialHeader ?? "Authorization") }
        for (name, value) in pending.headers ?? [:] { request.setValue(value, forHTTPHeaderField: name) }
        request.setValue(pending.contentType, forHTTPHeaderField: "Content-Type")
        request.setValue(pending.batchID, forHTTPHeaderField: "Idempotency-Key")
        return request
    }
    func cancel(_ identity: BatchIdentity) async {
        let tasks = await session.allTasks
        for task in tasks where BatchIdentity.decodeDescription(task.taskDescription) == identity && task.state != .completed {
            await withCheckedContinuation { continuation in
                cancellationWaiters[task.taskIdentifier, default: []].append(continuation)
                task.cancel()
            }
        }
    }
    func removeBody(_ identity: BatchIdentity) throws {
        let url = file(identity, suffix: ".body")
        if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
    }
    private func retryCompletionWrites() {
        for (key, result) in unsavedCompletions {
            do {
                try write(JSONEncoder().encode(result), to: file(result.identity, suffix: ".result"))
                unsavedCompletions[key] = nil
            } catch { storageError = "后台回执暂时无法保存；未确认批次保留，稍后重试" }
        }
        if unsavedCompletions.isEmpty { storageError = nil }
    }
    func storedCompletions() throws -> [(URL, UploadCompletion)] {
        retryCompletionWrites()
        guard FileManager.default.fileExists(atPath: directory.path) else { return [] }
        return try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "result" }
            .map { ($0, try JSONDecoder().decode(UploadCompletion.self, from: Data(contentsOf: $0))) }
    }
    func consumed(_ url: URL, identity: BatchIdentity) throws {
        let body = file(identity, suffix: ".body")
        if FileManager.default.fileExists(atPath: body.path) { try FileManager.default.removeItem(at: body) }
        try FileManager.default.removeItem(at: url)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard failures[dataTask.taskIdentifier] == nil else { return }
        let size = (responses[dataTask.taskIdentifier]?.count ?? 0) + data.count
        guard size <= 65_536 else {
            failures[dataTask.taskIdentifier] = "响应超过 64 KiB，批次未确认"
            responses[dataTask.taskIdentifier] = nil
            dataTask.cancel(); return
        }
        responses[dataTask.taskIdentifier, default: Data()].append(data)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
        defer {
            responses[task.taskIdentifier] = nil; failures[task.taskIdentifier] = nil
            let waiters = cancellationWaiters.removeValue(forKey: task.taskIdentifier) ?? []
            for waiter in waiters { waiter.resume() }
        }
        guard let description = task.taskDescription, let identity = try? JSONDecoder().decode(BatchIdentity.self, from: Data(description.utf8)) else { return }
        let response = task.response as? HTTPURLResponse
        var failure = failures[task.taskIdentifier]
        var retryable = failure == nil
        if error != nil, failure == nil { failure = "后台网络请求未完成，批次保留等待重试" }
        // Apple follows redirects in background sessions without invoking redirect delegates.
        // Reject the acknowledgement, but this is NOT prevention of redirect data disclosure.
        if BackgroundUploadPolicy.redirected(original: task.originalRequest?.url, current: task.currentRequest?.url, response: response?.url) {
            failure = "接口发生重定向，批次未确认；请使用无重定向的最终 HTTPS 地址"; retryable = false
        }
        let attempt = try? JSONDecoder().decode(UploadAttemptDescription.self, from: Data(description.utf8))
        let result = UploadCompletion(identity: identity, status: response?.statusCode, body: responses[task.taskIdentifier] ?? Data(), retryAfter: response?.value(forHTTPHeaderField: "Retry-After"), failure: failure, retryable: retryable,
            completedAt: Date(), completionID: UUID().uuidString, attemptID: attempt?.attemptID)
        unsavedCompletions[prefix(identity)] = result
        retryCompletionWrites()
        onCompletion?()
    }
    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        onCompletion?()
        let handlers = completions; completions.removeAll()
        for completion in handlers { completion() }
    }
}

@MainActor struct DeferredOnlySender: UploadSender {
    func send(_ upload: PendingUpload, destination: HTTPDestination) async throws -> Int { throw ConfigurationError("Watch 仅允许持久化后台传输") }
}
