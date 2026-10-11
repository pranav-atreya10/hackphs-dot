import Foundation

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
    static let cameraId = "iphone-1"
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
            SettingKey.apiKey: "",
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
            apiKey: d.string(forKey: SettingKey.apiKey) ?? "",
            airport: d.string(forKey: SettingKey.airport) ?? "",
            cameraId: d.string(forKey: SettingKey.cameraId) ?? SettingDefaults.cameraId,
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
