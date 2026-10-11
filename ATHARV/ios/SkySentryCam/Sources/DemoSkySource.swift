import CoreGraphics
import Foundation
import QuartzCore

/// Synthetic frames for the simulator (no camera): a light-blue sky with a V of six birds drifting
/// right to left, wings beating ~4 times a second. The bird model follows Vivan's synthetic sky
/// (VIVAN/detection/src/synthetic.js): positions in 320-px units, ellipses that widen and narrow as
/// the wings open and fold, darkening the sky under them by about 55 %.
final class DemoSkySource {
    /// Called on the demo queue at ~15 fps.
    var onFrame: ((CGImage) -> Void)?

    private let queue = DispatchQueue(label: "skysentry.demo", qos: .userInitiated)
    private var timer: DispatchSourceTimer?
    private var t0: CFTimeInterval = 0
    private let lock = NSLock()
    private var _portrait = true

    /// Portrait frames are 640x1136 (like a 720x1280 camera); landscape frames are 640x360.
    var portrait: Bool {
        get { lock.lock(); defer { lock.unlock() }; return _portrait }
        set { lock.lock(); _portrait = newValue; lock.unlock() }
    }

    func start() {
        guard timer == nil else { return }
        t0 = CACurrentMediaTime()
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now(), repeating: .milliseconds(66), leeway: .milliseconds(4))
        t.setEventHandler { [weak self] in self?.tick() }
        t.resume()
        timer = t
    }

    func stop() {
        timer?.cancel()
        timer = nil
    }

    private func tick() {
        let t = CACurrentMediaTime() - t0
        let size = portrait ? CGSize(width: 640, height: 1136) : CGSize(width: 640, height: 360)
        if let image = Self.render(time: t, size: size) { onFrame?(image) }
    }

    private static let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
    private static let sky = CGGradient(
        colorsSpace: colorSpace,
        colors: [CGColor(srgbRed: 0.47, green: 0.69, blue: 0.91, alpha: 1),
                 CGColor(srgbRed: 0.82, green: 0.90, blue: 0.97, alpha: 1)] as CFArray,
        locations: [0, 1])!

    // V formation flying left: leader in front, two trailing arms behind it (320-px units).
    private static let offsets: [(Double, Double)] = [(0, 0), (13, -8), (13, 8), (26, -16), (26, 16), (39, -24)]
    private static let hz: [Double] = [4.0, 4.2, 3.8, 4.1, 3.9, 4.25]
    private static let phase: [Double] = [0.0, 1.3, 2.1, 0.7, 3.0, 4.4]

    static func render(time t: Double, size: CGSize) -> CGImage? {
        let w = Int(size.width), h = Int(size.height)
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: colorSpace, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        // Top-left origin, like the normalized coordinates the server sends back.
        ctx.translateBy(x: 0, y: CGFloat(h))
        ctx.scaleBy(x: 1, y: -1)
        ctx.drawLinearGradient(sky, start: .zero, end: CGPoint(x: 0, y: h), options: [])

        let u = CGFloat(w) / 320                       // px per 320-px unit
        let unitsH = Double(h) / Double(u)

        // Two soft clouds drifting slowly.
        ctx.setFillColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 0.14))
        for (i, base) in [(60.0, 0.18), (230.0, 0.62)].enumerated() {
            let span = 320.0 + 120
            let x = (base.0 + Double(i + 1) * 3 * t).truncatingRemainder(dividingBy: span) - 60
            let y = unitsH * base.1
            for (dx, dy, r) in [(0.0, 0.0, 22.0), (20, 4, 16), (-20, 5, 15), (8, -8, 14)] {
                let cx = CGFloat(x + dx) * u, cy = CGFloat(y + dy) * u, rr = CGFloat(r) * u
                ctx.fillEllipse(in: CGRect(x: cx - rr, y: cy - rr * 0.7, width: rr * 2, height: rr * 1.4))
            }
        }

        // The flock: crosses in ~19 s, then loops.
        let cycle = 20.0
        let tt = t.truncatingRemainder(dividingBy: cycle)
        let leadX = 345 - 21 * tt
        let baseY = unitsH * 0.36 + 0.8 * tt
        ctx.setFillColor(CGColor(srgbRed: 0, green: 0, blue: 0, alpha: 0.55))
        for i in 0..<offsets.count {
            let ph = 2 * Double.pi * hz[i] * t + phase[i]
            let open = 0.5 + 0.5 * cos(ph)              // 1 = wings spread, 0 = folded
            let span = 5.5
            let rx = span * (0.45 + 0.55 * open)
            let ry = span * 0.22 * (1 + 0.8 * abs(sin(ph)))
            let x = leadX + offsets[i].0
            let y = baseY + offsets[i].1 + 0.6 * sin(ph)
            ctx.fillEllipse(in: CGRect(x: CGFloat(x - rx) * u, y: CGFloat(y - ry) * u,
                                       width: CGFloat(2 * rx) * u, height: CGFloat(2 * ry) * u))
        }
        return ctx.makeImage()
    }
}
