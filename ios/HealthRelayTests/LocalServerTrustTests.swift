import XCTest
import Security
@testable import HealthRelay

final class LocalServerTrustTests: XCTestCase {
    // Synthetic CA and leaf for healthrelay.test; private keys stay outside Git.
    let ca = Data(base64Encoded: "MIICzDCCAbQCCQDexNmh7gARPTANBgkqhkiG9w0BAQsFADAoMSYwJAYDVQQDDB1IZWFsdGhSZWxheSBTeW50aGV0aWMgVGVzdCBDQTAeFw0yNjEwMjAxMzMxMjJaFw0zNjEwMTcxMzMxMjJaMCgxJjAkBgNVBAMMHUhlYWx0aFJlbGF5IFN5bnRoZXRpYyBUZXN0IENBMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0FMHAfBFJmnsw5GFzKp7qMv3TQAfl1TQMkwGPn2XWrWijQ3B5FfQXouVV5MojRfPzX6R4uhtRFjXV2FvJ+vcnVq/QHn+LebSx4MlijBSChXm643gPXzb/FYMbjEAylREBoHKHC3fiCAkSQFu45ygrFJE/jBkaNcnNGp47MiqzcatlR/IAxuUP9o6a5ETHk9WA5G+OQPX/2jSKHeS48o63SCniU8jxwCKlAzruHTswqFZGSy2E+Ss0o3dtBGcodqZc6mF0wV8Ujofpxd7RCFVNf4kWR4fGI9ZjtOAMtUplmGJvqcsIF1fGuYCbsEDnnahOmHc0lcnwZSJA1MQ0gjIRQIDAQABMA0GCSqGSIb3DQEBCwUAA4IBAQAG2aFdTlklso/sEk5VKBNSAU/W+S2F18r/3AXXD9pgeLdIiyzaSLgR7OrjZHdOVhy0HE/5xesKzoqa2bPBfq3KQUtEg6c9sSzXsdGr7iImAR3VFkHdurVdcLl4ocx7sTG3b4+zI7N+o1wgxbomK1blN8qkZKl6tENSRDb5XJEIO53dEOMrJ9PfAwlibYJo+uMripSMwSFO7NJUMfL2djT8dsj2f7p9/1qMcu7X6ddqno933KxRxyaeaBRVrtCsIWkcOgISUYPIXWkAkiOtWWC/pxMbzmPup4l3XBVyPIEYtXQqPPowOOTjkgpMdzvrx87qusvf+p1ijUws8axk46EC")!
    let leaf = Data(base64Encoded: "MIIDBTCCAe2gAwIBAgIJAOjX8lto3TCZMA0GCSqGSIb3DQEBCwUAMCgxJjAkBgNVBAMMHUhlYWx0aFJlbGF5IFN5bnRoZXRpYyBUZXN0IENBMB4XDTI2MTAyMDEzNDMzOVoXDTI3MTAyMDEzNDMzOVowGzEZMBcGA1UEAwwQaGVhbHRocmVsYXkudGVzdDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAMtJBGMf+gyG1y2QR8QUCbRGTtcxUDOjm2e1D5qXt/WLoEnFI0proGbnQ8iACcoNkCqu7PdT9scIWuz0EqG59VtYSaH7zn9S/zY8qpQQoMg+RZNRzA4UTxCDlh+XsaeNF6qePMYBEsDbIbfYxoVbJdcM17cvgIyGorigJNyGjGnjubarkOO/i4r2tAidF+VFbazky/w3TwX8SiPZoOamsqMqfkNuYPngKql3AV10o/5VvaxdA0ViChcnbq5Z7ke5/xS8tuPFVBzbKrOdz/dG3ZaeLnC1oGK/1c0MWvBRvHCCmCDNXQBLwSBMT/wJZqbdKySDBNpcxLSHYvqrYRhslg0CAwEAAaM/MD0wGwYDVR0RBBQwEoIQaGVhbHRocmVsYXkudGVzdDAJBgNVHRMEAjAAMBMGA1UdJQQMMAoGCCsGAQUFBwMBMA0GCSqGSIb3DQEBCwUAA4IBAQA4VqxhIMra469JzRYfmrFLG0xVa/vBsQLA9Yq7yOq/grRxair9rZfiXe9vuekn76CUhAlV/05155S0qLqUQRevYLVzgQn/mNvOd1FBrufnQlY3+f5HWUbi1e7xMnMW7U0E1a+LlN7pnpycPVJyS/N0PgwLjqm1DmWPBSmB0n4sreYFIHhAVVR9RANiKHWSniof40rzPJYYp7aLqjwzu+tRPvE8YE9pFR8qW8jky9Kkb1OUjuywaVs2/i4dgj4kKvcfrxbYfPVG4winiSO/Ixn/Z8R4bwNjgEiYgdurwSpJsOo5Hd/tof6EVDDL5l98sZJduahoc3odPhz97rPPYB0L")!
    func trust() throws -> SecTrust {
        let certificate = try XCTUnwrap(SecCertificateCreateWithData(nil, leaf as CFData))
        var result: SecTrust?
        XCTAssertEqual(SecTrustCreateWithCertificates(certificate, SecPolicyCreateBasicX509(), &result), errSecSuccess)
        let trust = try XCTUnwrap(result)
        SecTrustSetVerifyDate(trust, Date(timeIntervalSince1970: 1792589482) as CFDate)
        return trust
    }
    func testExplicitLocalCARequiresAValidChainAndTheRequestedHostname() throws {
        XCTAssertTrue(LocalServerTrust.evaluate(try trust(), host: "healthrelay.test", certificateData: ca))
        XCTAssertFalse(LocalServerTrust.evaluate(try trust(), host: "other.test", certificateData: ca))
        XCTAssertFalse(LocalServerTrust.evaluate(try trust(), host: "healthrelay.test", certificateData: Data("invalid".utf8)))
    }
}
