import Foundation
import Security

/// Optional, explicitly provisioned local CA. Certificate chain, lifetime and
/// requested hostname remain mandatory; this never accepts an arbitrary leaf.
enum LocalServerTrust {
    static var certificateURL: URL {
        URL.applicationSupportDirectory.appendingPathComponent("HealthRelayWatch/trusted-server.cer")
    }
    static func evaluate(_ trust: SecTrust, host: String, certificateData: Data) -> Bool {
        guard !host.isEmpty, let anchor = SecCertificateCreateWithData(nil, certificateData as CFData) else { return false }
        guard SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, host as CFString)) == errSecSuccess,
              SecTrustSetAnchorCertificates(trust, [anchor] as CFArray) == errSecSuccess,
              SecTrustSetAnchorCertificatesOnly(trust, false) == errSecSuccess else { return false }
        var failure: CFError?
        let accepted = SecTrustEvaluateWithError(trust, &failure)
        #if DEBUG
        if !accepted { NSLog("HealthRelay local CA rejected: %@", String(describing: failure)) }
        #endif
        return accepted
    }
}
