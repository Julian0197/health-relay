import Foundation
import Security
import HealthRelayCore

struct CredentialStore {
    private let service = "org.healthrelay.automation-credentials"
    func save(_ value: String) throws -> String {
        let reference = UUID().uuidString
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: reference,
            kSecValueData as String: Data(value.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        ]
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw ConfigurationError("认证信息保存失败（\(status)）") }
        return reference
    }
    func read(_ reference: String) throws -> String {
        var result: CFTypeRef?
        let status = SecItemCopyMatching([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: reference,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ] as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data, let value = String(data: data, encoding: .utf8) else {
            throw UploadFailure(status == errSecInteractionNotAllowed ? "设备锁定，认证值暂不可读" : "认证值无法读取，请重新填写", retryable: status == errSecInteractionNotAllowed)
        }
        return value
    }
    func delete(_ reference: String) {
        SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: reference
        ] as CFDictionary)
    }
}
