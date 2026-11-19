import Foundation
import Security

enum CameraCredentials {
    private static let service = (Bundle.main.bundleIdentifier ?? "SkySentryCam") + ".camera"

    private static func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    private static func read(_ account: String) -> (OSStatus, String?) {
        var q = query(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &item)
        return (status, (item as? Data).flatMap { String(data: $0, encoding: .utf8) })
    }

    private static func write(_ value: String, account: String) -> Bool {
        let q = query(account)
        let fields: [String: Any] = [kSecValueData as String: Data(value.utf8)]
        let updated = SecItemUpdate(q as CFDictionary, fields as CFDictionary)
        if updated != errSecItemNotFound { return updated == errSecSuccess }
        var item = q.merging(fields) { _, value in value }
        item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        return SecItemAdd(item as CFDictionary, nil) == errSecSuccess
    }

    static func migrate(from defaults: UserDefaults = .standard) {
        guard let legacy = defaults.string(forKey: SettingKey.apiKey) else { return }
        let (status, _) = read("api-key")
        if status == errSecSuccess || (status == errSecItemNotFound && write(legacy, account: "api-key")) {
            defaults.removeObject(forKey: SettingKey.apiKey)
        }
    }

    static var apiKey: String { read("api-key").1 ?? "" }

    static func saveAPIKey(_ value: String) -> Bool {
        // Store an empty value too, so clearing the field cannot restore a legacy key.
        guard write(value, account: "api-key") else { return false }
        UserDefaults.standard.removeObject(forKey: SettingKey.apiKey)
        return true
    }

    static var deviceId: String? {
        let (status, stored) = read("device-id")
        if status == errSecSuccess, let stored, UUID(uuidString: stored) != nil { return stored }
        guard status == errSecItemNotFound else { return nil }
        let id = UUID().uuidString.lowercased()
        var q = query("device-id")
        q[kSecValueData as String] = Data(id.utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let added = SecItemAdd(q as CFDictionary, nil)
        if added == errSecDuplicateItem { return read("device-id").1 }
        return added == errSecSuccess ? id : nil
    }
}

/// UserDefaults keys shared by the @AppStorage properties and the streaming code.
enum SettingKey {
    static let serverURL = "serverURL"
    static let apiKey = "apiKey"
    static let airport = "airport"
    static let cameraId = "cameraId"
    static let heading = "headingDeg"
    static let hfov = "hfovDeg"
    static let lat = "lat"
    static let lon = "lon"
    static let corridorSide = "corridorSide"
    static let corridorWidth = "corridorWidth"
    static let sourcePref = "sourcePref"
    static let demoClip = "demoClip"
    static let fillVideo = "fillVideo"
}

/// Defaults registered at launch, so @AppStorage and StreamSettings.load() always agree.
enum SettingDefaults {
    static let serverURL = "http://localhost:8095"
    static var cameraId: String { CameraCredentials.deviceId.map { "iphone-" + String($0.prefix(8)) } ?? "iPhone" }
    static let demoClip = "gulls-sky.mp4"
    static let heading = 90.0
    static let hfov = 65.0
    static let lat = 40.3987
    static let lon = -74.6586
    static let corridorSide = "left"
    static let corridorWidth = 0.3

    static var all: [String: Any] {
        [
            SettingKey.serverURL: serverURL,
            SettingKey.airport: "",
            SettingKey.cameraId: cameraId,
            SettingKey.heading: heading,
            SettingKey.hfov: hfov,
            SettingKey.lat: lat,
            SettingKey.lon: lon,
            SettingKey.corridorSide: corridorSide,
            SettingKey.corridorWidth: corridorWidth,
            SettingKey.sourcePref: SourcePreference.auto.rawValue,
            SettingKey.demoClip: demoClip,
            SettingKey.fillVideo: true,
        ]
    }
}

enum SourcePreference: String, CaseIterable, Identifiable {
    case auto, camera, demo, clip
    var id: String { rawValue }
    var label: String {
        switch self {
        case .auto: return "Automatic"
        case .camera: return "Rear camera"
        case .demo: return "Demo sky"
        case .clip: return "Demo video"
        }
    }
}

/// A snapshot of everything the uploader needs; read from UserDefaults when streaming starts or settings change.
struct StreamSettings: Equatable {
    var serverURL: String
    var apiKey: String
    var deviceId: String?
    var airport: String
    var cameraId: String
    var heading: Double
    var hfov: Double
    var lat: Double
    var lon: Double
    var corridorSide: String
    var corridorWidth: Double

    var corridor: [[Double]] { Self.corridor(side: corridorSide, width: corridorWidth) }

    /// Runway approach area as normalized [x, y] points (0..1 across the frame).
    static func corridor(side: String, width: Double) -> [[Double]] {
        let w = min(max(width, 0.05), 1)
        if side == "right" {
            return [[1 - w, 0], [1, 0], [1, 1], [1 - w, 1]]
        }
        return [[0, 0], [w, 0], [w, 1], [0, 1]]
    }

    static func load(from d: UserDefaults = .standard) -> StreamSettings {
        StreamSettings(
            serverURL: d.string(forKey: SettingKey.serverURL) ?? SettingDefaults.serverURL,
            apiKey: CameraCredentials.apiKey,
            deviceId: CameraCredentials.deviceId,
            airport: d.string(forKey: SettingKey.airport) ?? "",
            cameraId: d.string(forKey: SettingKey.cameraId).flatMap { $0 == "iphone-1" ? nil : $0 } ?? SettingDefaults.cameraId,
            heading: d.object(forKey: SettingKey.heading) as? Double ?? SettingDefaults.heading,
            hfov: d.object(forKey: SettingKey.hfov) as? Double ?? SettingDefaults.hfov,
            lat: d.object(forKey: SettingKey.lat) as? Double ?? SettingDefaults.lat,
            lon: d.object(forKey: SettingKey.lon) as? Double ?? SettingDefaults.lon,
            corridorSide: d.string(forKey: SettingKey.corridorSide) ?? SettingDefaults.corridorSide,
            corridorWidth: d.object(forKey: SettingKey.corridorWidth) as? Double ?? SettingDefaults.corridorWidth
        )
    }
}

/// Compass point for a heading, e.g. 90 -> "E".
func compassPoint(_ degrees: Double) -> String {
    let names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
    let d = (degrees.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360)
    return names[Int((d + 22.5) / 45) % 8]
}
