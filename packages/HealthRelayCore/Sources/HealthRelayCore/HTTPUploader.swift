import Foundation

public struct UploadFailure: Error, LocalizedError, Sendable {
    public var message: String
    public var retryable: Bool
    public var retryAfter: TimeInterval?
    public var status: Int?
    public var errorDescription: String? { message }
    public init(_ message: String, retryable: Bool, retryAfter: TimeInterval? = nil, status: Int? = nil) {
        self.message = message; self.retryable = retryable; self.retryAfter = retryAfter; self.status = status
    }
}
public enum HTTPAcknowledgement {
    private struct Receipt: Decodable { var batchId: String; var committed: Bool; var accepted: Int; var duplicates: Int }
    public static func validate(status: Int, data: Data, batchID: String, count: Int, mode: HTTPDestination.Acknowledgement) throws {
        guard (200...299).contains(status), status != 202 else {
            throw UploadFailure("接口返回 HTTP \(status)，批次未确认", retryable: status == 408 || status == 429 || status >= 500, status: status)
        }
        if mode == .receipt {
            guard [200, 201].contains(status), let receipt = try? JSONDecoder().decode(Receipt.self, from: data),
                receipt.batchId == batchID, receipt.committed, receipt.accepted >= 0, receipt.duplicates >= 0,
                receipt.accepted <= count, receipt.duplicates == count - receipt.accepted else {
                throw UploadFailure("接口回执不匹配，批次保留等待检查", retryable: false, status: status)
            }
        }
    }
}
@MainActor public protocol UploadSender {
    func send(_ upload: PendingUpload, destination: HTTPDestination) async throws -> Int
}
public final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate, Sendable {
    public func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
}
@MainActor public final class HTTPUploader: UploadSender {
    private let session: URLSession
    private let credential: (String) throws -> String
    public init(session: URLSession? = nil, credential: @escaping (String) throws -> String) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        self.session = session ?? URLSession(configuration: configuration, delegate: NoRedirectDelegate(), delegateQueue: nil)
        self.credential = credential
    }
    public func send(_ upload: PendingUpload, destination: HTTPDestination) async throws -> Int {
        guard let url = URL(string: destination.url), url.scheme == "https", url.host != nil else { throw ConfigurationError("接口必须使用 HTTPS") }
        var request = URLRequest(url: url, timeoutInterval: TimeInterval(destination.timeoutSeconds))
        request.httpMethod = "POST"; request.httpBody = upload.body
        for (key, value) in destination.headers { request.setValue(value, forHTTPHeaderField: key) }
        for (key, reference) in destination.secretHeaders ?? [:] { request.setValue(try credential(reference), forHTTPHeaderField: key) }
        if let reference = destination.credentialRef {
            request.setValue((destination.credentialPrefix ?? "") + (try credential(reference)), forHTTPHeaderField: destination.credentialHeader ?? "Authorization")
        }
        request.setValue(upload.contentType, forHTTPHeaderField: "Content-Type")
        request.setValue(upload.batchID, forHTTPHeaderField: "Idempotency-Key")
        let response: (Data, URLResponse)
        do { response = try await session.data(for: request) }
        catch is CancellationError { throw CancellationError() }
        catch let error as URLError {
            if error.code == .cancelled { throw CancellationError() }
            throw UploadFailure("网络请求未完成（\(error.code.rawValue)），批次已保留", retryable: error.code != .cancelled)
        }
        guard let http = response.1 as? HTTPURLResponse else { throw UploadFailure("接口响应无效", retryable: true) }
        do { try HTTPAcknowledgement.validate(status: http.statusCode, data: response.0, batchID: upload.batchID, count: upload.recordCount, mode: destination.acknowledgement) }
        catch var error as UploadFailure {
            if let seconds = http.value(forHTTPHeaderField: "Retry-After").flatMap(Double.init) { error.retryAfter = max(0, seconds) }
            throw error
        }
        return http.statusCode
    }
}
