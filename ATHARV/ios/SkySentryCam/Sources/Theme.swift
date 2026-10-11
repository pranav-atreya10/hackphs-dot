import SwiftUI

extension Color {
    /// Color from a 0xRRGGBB literal, e.g. Color(hex: 0xc2643f).
    init(hex: UInt32, opacity: Double = 1) {
        self.init(.sRGB,
                  red: Double((hex >> 16) & 0xff) / 255,
                  green: Double((hex >> 8) & 0xff) / 255,
                  blue: Double(hex & 0xff) / 255,
                  opacity: opacity)
    }
}

/// The team website's look: warm paper, ink text, terracotta accent, serif headings.
enum Theme {
    static let paper = Color(hex: 0xf4efe6)
    static let card = Color(hex: 0xfbf8f2)
    static let ink = Color(hex: 0x1f1b16)
    static let muted = Color(hex: 0x6f665b)
    static let accent = Color(hex: 0xc2643f)

    // Overlay colors by classification.
    static let bird = Color(hex: 0x4f9cff)
    static let drone = Color(hex: 0xff5a4a)
    static let unknown = Color(hex: 0xf2b705)

    // Risk levels.
    static let riskGreen = Color(hex: 0x2e8b57)
    static let riskYellow = Color(hex: 0xd99a00)
    static let riskRed = Color(hex: 0xc0392b)

    static func serif(_ style: Font.TextStyle, weight: Font.Weight = .semibold) -> Font {
        .system(style, design: .serif).weight(weight)
    }

    static func riskColor(_ risk: String?) -> Color {
        switch risk?.lowercased() {
        case "red": return riskRed
        case "yellow": return riskYellow
        case "green": return riskGreen
        default: return ink
        }
    }

    static func classColor(_ classification: String?) -> Color {
        switch classification?.lowercased() {
        case "bird": return bird
        case "drone": return drone
        default: return unknown
        }
    }
}
