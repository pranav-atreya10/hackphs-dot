import Foundation

// The server bot's overlay state (see PRANAV/bot.js `compact`). Every field is optional and
// decoding is lenient, so a small change on the server never breaks the app.

struct NormBox: Decodable, Equatable {
    var x: Double
    var y: Double
    var w: Double
    var h: Double
}

struct PrimaryThreat: Decodable, Equatable {
    var size: Double?
    var classification: String?
    var eta_seconds: Double?
    var bearing_deg: Double?
    var flap_hz: Double?
    var heading: String?
    var kind: String?
}

struct BotTrack: Decodable, Equatable, Identifiable {
    var id: String
    var bbox: NormBox?
    var classification: String?
    var flap_hz: Double?
    var eta_seconds: Double?
    var is_flock: Bool?
    var trail: [[Double]]?

    enum CodingKeys: String, CodingKey { case id, bbox, classification, flap_hz, eta_seconds, is_flock, trail }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = decodeLooseId(c, .id)
        bbox = try? c.decodeIfPresent(NormBox.self, forKey: .bbox)
        classification = try? c.decodeIfPresent(String.self, forKey: .classification)
        flap_hz = try? c.decodeIfPresent(Double.self, forKey: .flap_hz)
        eta_seconds = try? c.decodeIfPresent(Double.self, forKey: .eta_seconds)
        is_flock = try? c.decodeIfPresent(Bool.self, forKey: .is_flock)
        trail = try? c.decodeIfPresent([[Double]].self, forKey: .trail)
    }
}

struct BotFlock: Decodable, Equatable, Identifiable {
    var id: String
    var bbox: NormBox?
    var size: Double?
    var eta_seconds: Double?

    enum CodingKeys: String, CodingKey { case id, bbox, size, eta_seconds }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = decodeLooseId(c, .id)
        bbox = try? c.decodeIfPresent(NormBox.self, forKey: .bbox)
        size = try? c.decodeIfPresent(Double.self, forKey: .size)
        eta_seconds = try? c.decodeIfPresent(Double.self, forKey: .eta_seconds)
    }
}

struct BotState: Decodable, Equatable {
    var t: Double?
    var risk: String?
    var reasons: [String]?
    var primary: PrimaryThreat?
    var tracks: [BotTrack]?
    var flocks: [BotFlock]?
    var fps: Double?
    var proc_ms: Double?
    var learning: Bool?
    var shake: Bool?

    enum CodingKeys: String, CodingKey { case t, risk, reasons, primary, tracks, flocks, fps, proc_ms, learning, shake }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        t = try? c.decodeIfPresent(Double.self, forKey: .t)
        risk = try? c.decodeIfPresent(String.self, forKey: .risk)
        reasons = try? c.decodeIfPresent([String].self, forKey: .reasons)
        primary = try? c.decodeIfPresent(PrimaryThreat.self, forKey: .primary)
        tracks = try? c.decodeIfPresent([BotTrack].self, forKey: .tracks)
        flocks = try? c.decodeIfPresent([BotFlock].self, forKey: .flocks)
        fps = try? c.decodeIfPresent(Double.self, forKey: .fps)
        proc_ms = try? c.decodeIfPresent(Double.self, forKey: .proc_ms)
        learning = try? c.decodeIfPresent(Bool.self, forKey: .learning)
        shake = try? c.decodeIfPresent(Bool.self, forKey: .shake)
    }
}

struct FrameReply: Decodable {
    var ok: Bool?
    var bot: String?
    var state: BotState?
    var error: String?
}

private func decodeLooseId<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ key: K) -> String {
    if let i = try? c.decode(Int.self, forKey: key) { return String(i) }
    if let d = try? c.decode(Double.self, forKey: key) { return String(d) }
    if let s = try? c.decode(String.self, forKey: key) { return s }
    return UUID().uuidString
}

extension PrimaryThreat {
    /// One line for the banner, e.g. "Flock of 6 birds · heading south · 9 s to runway".
    var summary: String {
        var parts: [String] = []
        let cls = (classification ?? "unknown").lowercased()
        let n = Int((size ?? 1).rounded())
        if kind == "flock" || n > 1 {
            let noun = cls == "bird" ? "birds" : cls == "drone" ? "drones" : "objects"
            parts.append("Flock of \(n) \(noun)")
        } else {
            parts.append(cls == "bird" ? "Bird" : cls == "drone" ? "Drone" : "Unknown object")
        }
        if let h = heading, !h.isEmpty { parts.append("heading \(h)") }
        if let e = eta_seconds, e.isFinite {
            parts.append(e < 0.5 ? "at the runway" : "\(Int(e.rounded())) s to runway")
        } else if let f = flap_hz, f > 0 {
            parts.append(String(format: "wings %.1f Hz", f))
        }
        return parts.joined(separator: " · ")
    }
}
