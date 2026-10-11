import SwiftUI

/// Maps normalized frame coordinates (0..1) to view points, matching how the video is shown
/// (aspect-fill crops the frame's edges; aspect-fit letterboxes it).
struct FrameMapper {
    let rect: CGRect

    init(frame: CGSize, view: CGSize, fill: Bool) {
        guard frame.width > 0, frame.height > 0, view.width > 0, view.height > 0 else {
            rect = CGRect(origin: .zero, size: view)
            return
        }
        let sx = view.width / frame.width, sy = view.height / frame.height
        let s = fill ? max(sx, sy) : min(sx, sy)
        let w = frame.width * s, h = frame.height * s
        rect = CGRect(x: (view.width - w) / 2, y: (view.height - h) / 2, width: w, height: h)
    }

    func point(_ x: Double, _ y: Double) -> CGPoint {
        CGPoint(x: rect.minX + CGFloat(x) * rect.width, y: rect.minY + CGFloat(y) * rect.height)
    }

    func box(_ b: NormBox) -> CGRect {
        CGRect(x: rect.minX + CGFloat(b.x) * rect.width, y: rect.minY + CGFloat(b.y) * rect.height,
               width: CGFloat(b.w) * rect.width, height: CGFloat(b.h) * rect.height)
    }
}

/// The server bot's overlay: runway corridor, track boxes and trails, flock boxes.
struct OverlayView: View {
    let state: BotState?
    let frameSize: CGSize
    let corridor: [[Double]]
    let fill: Bool

    var body: some View {
        Canvas { ctx, size in
            let m = FrameMapper(frame: frameSize, view: size, fill: fill)
            drawCorridor(&ctx, m)
            guard let state else { return }

            for track in state.tracks ?? [] where track.classification?.lowercased() != "rejected" {
                guard let bbox = track.bbox else { continue }
                let color = Theme.classColor(track.classification)
                if let trail = track.trail, trail.count > 1 {
                    var p = Path()
                    for (i, pt) in trail.enumerated() where pt.count >= 2 {
                        let q = m.point(pt[0], pt[1])
                        if i == 0 { p.move(to: q) } else { p.addLine(to: q) }
                    }
                    ctx.stroke(p, with: .color(color.opacity(0.65)), style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
                }
                let r = m.box(bbox).insetBy(dx: -4, dy: -4)
                ctx.stroke(Path(roundedRect: r, cornerRadius: 3), with: .color(color), lineWidth: 2)
                if track.is_flock != true {
                    label(&ctx, trackLabel(track), color: color, above: r, in: size)
                }
            }

            for flock in state.flocks ?? [] {
                guard let bbox = flock.bbox else { continue }
                let r = m.box(bbox).insetBy(dx: -10, dy: -10)
                ctx.stroke(Path(roundedRect: r, cornerRadius: 6), with: .color(Theme.bird),
                           style: StrokeStyle(lineWidth: 2.5, dash: [7, 4]))
                var text = "flock of \(Int((flock.size ?? 0).rounded()))"
                if let eta = flock.eta_seconds, eta.isFinite { text += " · \(max(0, Int(eta.rounded())))s" }
                label(&ctx, text, color: Theme.bird, above: r, in: size)
            }
        }
        .allowsHitTesting(false)
    }

    private func trackLabel(_ t: BotTrack) -> String {
        var s = (t.classification ?? "unknown").lowercased()
        if let hz = t.flap_hz, hz > 0 { s += String(format: " %.0fHz", hz) }
        if let eta = t.eta_seconds, eta.isFinite { s += " · \(max(0, Int(eta.rounded())))s" }
        return s
    }

    private func drawCorridor(_ ctx: inout GraphicsContext, _ m: FrameMapper) {
        guard corridor.count >= 3 else { return }
        var p = Path()
        for (i, c) in corridor.enumerated() where c.count >= 2 {
            let q = m.point(c[0], c[1])
            if i == 0 { p.move(to: q) } else { p.addLine(to: q) }
        }
        p.closeSubpath()
        ctx.fill(p, with: .color(Theme.accent.opacity(0.20)))
        ctx.stroke(p, with: .color(Theme.accent.opacity(0.9)), style: StrokeStyle(lineWidth: 2, dash: [10, 6]))

        let b = p.boundingRect
        let text = ctx.resolve(Text("RUNWAY APPROACH").font(.system(size: 10, weight: .bold)).kerning(1.2).foregroundColor(.white))
        let sz = text.measure(in: CGSize(width: 300, height: 40))
        let origin = CGPoint(x: max(b.minX + 8, 8), y: b.midY + 40)
        let bg = CGRect(x: origin.x - 6, y: origin.y - 3, width: sz.width + 12, height: sz.height + 6)
        ctx.fill(Path(roundedRect: bg, cornerRadius: 4), with: .color(Theme.accent.opacity(0.9)))
        ctx.draw(text, at: origin, anchor: .topLeading)
    }

    private func label(_ ctx: inout GraphicsContext, _ string: String, color: Color, above r: CGRect, in size: CGSize) {
        let text = ctx.resolve(Text(string).font(.system(size: 11, weight: .semibold).monospacedDigit()).foregroundColor(.white))
        let sz = text.measure(in: CGSize(width: 300, height: 40))
        var x = r.minX
        var y = r.minY - sz.height - 6
        if y < 4 { y = r.maxY + 4 }
        x = min(max(4, x), size.width - sz.width - 12)
        let bg = CGRect(x: x, y: y, width: sz.width + 10, height: sz.height + 4)
        ctx.fill(Path(roundedRect: bg, cornerRadius: 4), with: .color(color.opacity(0.9)))
        ctx.draw(text, at: CGPoint(x: x + 5, y: y + 2), anchor: .topLeading)
    }
}
