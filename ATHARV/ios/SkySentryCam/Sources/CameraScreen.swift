import SwiftUI
import UIKit

/// Full-screen video with the bot's overlay, risk banner, stats and Start/Stop.
struct CameraScreen: View {
    @StateObject private var stream = StreamController()

    @AppStorage(SettingKey.sourcePref) private var sourcePref = SourcePreference.auto.rawValue
    @AppStorage(SettingKey.fillVideo) private var fillVideo = true
    @AppStorage(SettingKey.corridorSide) private var corridorSide = SettingDefaults.corridorSide
    @AppStorage(SettingKey.corridorWidth) private var corridorWidth = SettingDefaults.corridorWidth

    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var showSettings = false

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            GeometryReader { geo in
                ZStack {
                    if stream.source == .camera {
                        CameraPreview(camera: stream.camera, fill: fillVideo)
                    } else {
                        DemoSkyView(store: stream.demoFrames, fill: fillVideo)
                    }
                    OverlayView(state: stream.streaming && !stream.stateIsStale ? stream.state : nil,
                                frameSize: stream.frameSize,
                                corridor: StreamSettings.corridor(side: corridorSide, width: corridorWidth),
                                fill: fillVideo)
                }
                .frame(width: geo.size.width, height: geo.size.height)
                .clipped()
                .onAppear { stream.setDemoPortrait(geo.size.height >= geo.size.width) }
                .onChange(of: geo.size) { _, size in stream.setDemoPortrait(size.height >= size.width) }
            }
            .ignoresSafeArea()

            VStack(spacing: 10) {
                topBar
                Spacer(minLength: 0)
                if let message = stream.errorMessage { errorCard(message) }
                bottomBar
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
        }
        .statusBarHidden(false)
        .onAppear {
            stream.activate(SourcePreference(rawValue: sourcePref) ?? .auto)
            // Testing hook: `xcrun simctl launch … -autoStart YES` starts streaming right away.
            if UserDefaults.standard.bool(forKey: "autoStart") {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { stream.startStreaming() }
            }
        }
        .onDisappear { stream.shutdown() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background { stream.stopStreaming() }
        }
        .sheet(isPresented: $showSettings, onDismiss: { stream.settingsChanged() }) {
            NavigationStack {
                SetupView(onOpenCamera: nil)
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Done") { showSettings = false }
                        }
                    }
            }
        }
    }

    // MARK: Top: close, risk banner, settings

    private var topBar: some View {
        HStack(alignment: .top, spacing: 10) {
            roundButton("xmark", label: "Close camera") { dismiss() }
            RiskBanner(streaming: stream.streaming, state: stream.state, bot: stream.bot, stale: stream.stateIsStale)
                .frame(maxWidth: 560)
            roundButton("gearshape.fill", label: "Settings") { showSettings = true }
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: Bottom: stats and controls

    private var bottomBar: some View {
        VStack(spacing: 10) {
            statsRow
            HStack(spacing: 14) {
                sourceMenu
                Spacer(minLength: 0)
                startStopButton
                Spacer(minLength: 0)
                roundButton(fillVideo ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right",
                            label: fillVideo ? "Fit whole frame" : "Fill screen") { fillVideo.toggle() }
            }
            .frame(maxWidth: 560)
        }
    }

    private var statsRow: some View {
        HStack(spacing: 12) {
            HStack(spacing: 5) {
                Circle().fill(stream.status.color).frame(width: 8, height: 8)
                Text(stream.status.label)
            }
            stat("\(stream.framesSent)", "frames")
            stat(String(format: "%.1f", stream.achievedFps), "fps")
            if let bot = stream.bot {
                stat(bot, "bot")
            }
            if let ms = stream.state?.proc_ms, stream.streaming {
                stat(String(format: "%.0f", ms), "ms")
            }
        }
        .font(.caption.weight(.medium).monospacedDigit())
        .foregroundStyle(.white)
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(Capsule().fill(Color.black.opacity(0.55)))
    }

    private func stat(_ value: String, _ unit: String) -> some View {
        HStack(spacing: 3) {
            Text(value).fontWeight(.bold)
            Text(unit).foregroundStyle(.white.opacity(0.7))
        }
    }

    private var startStopButton: some View {
        Button {
            if stream.streaming { stream.stopStreaming() } else { stream.startStreaming() }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: stream.streaming ? "stop.fill" : "dot.radiowaves.left.and.right")
                Text(stream.streaming ? "Stop" : "Start streaming")
            }
            .font(.headline)
            .foregroundStyle(.white)
            .padding(.horizontal, 22)
            .padding(.vertical, 14)
            .background(Capsule().fill(stream.streaming ? Theme.ink.opacity(0.85) : Theme.accent))
            .overlay(Capsule().stroke(.white.opacity(0.35), lineWidth: 1))
        }
        .accessibilityIdentifier("startStop")
    }

    private var sourceMenu: some View {
        Menu {
            Button {
                sourcePref = SourcePreference.camera.rawValue
                stream.switchTo(.camera)
            } label: {
                Label(CameraSource.isAvailable ? "Rear camera" : "Rear camera (not available)", systemImage: "camera")
            }
            .disabled(!CameraSource.isAvailable)
            Button {
                sourcePref = SourcePreference.demo.rawValue
                stream.switchTo(.demo)
            } label: {
                Label("Demo sky", systemImage: "bird")
            }
        } label: {
            circle(stream.source == .camera ? "camera.fill" : "cloud.sun.fill")
        }
        .accessibilityLabel("Video source")
    }

    // MARK: Errors

    private func errorCard(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Theme.accent)
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(Theme.ink)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                Button { stream.errorMessage = nil } label: {
                    Image(systemName: "xmark").font(.caption.bold()).foregroundStyle(Theme.muted)
                }
                .accessibilityLabel("Dismiss")
            }
            if stream.cameraDenied {
                HStack {
                    Button("Open Settings") {
                        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                    }
                    .buttonStyle(.borderedProminent)
                    Button("Use demo sky") {
                        sourcePref = SourcePreference.demo.rawValue
                        stream.errorMessage = nil
                        stream.switchTo(.demo)
                    }
                    .buttonStyle(.bordered)
                }
                .tint(Theme.accent)
            } else if stream.status == .stopped {
                Button("Open settings") { showSettings = true }
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.accent)
            }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 14).fill(Theme.paper))
        .frame(maxWidth: 560)
    }

    // MARK: Helpers

    private func roundButton(_ systemImage: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { circle(systemImage) }
            .accessibilityLabel(label)
    }

    private func circle(_ systemImage: String) -> some View {
        Image(systemName: systemImage)
            .font(.system(size: 17, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: 44, height: 44)
            .background(Circle().fill(Color.black.opacity(0.55)))
    }
}

/// Shows the demo sky frames, scaled the same way as the camera preview.
struct DemoSkyView: View {
    @ObservedObject var store: DemoFrameStore
    let fill: Bool

    var body: some View {
        GeometryReader { geo in
            if let cg = store.image {
                Image(decorative: cg, scale: 1)
                    .resizable()
                    .interpolation(.medium)
                    .aspectRatio(contentMode: fill ? .fill : .fit)
                    .frame(width: geo.size.width, height: geo.size.height)
                    .clipped()
            } else {
                Color(hex: 0x9cc4ea)
            }
        }
    }
}

/// Risk level and one line about the main threat.
struct RiskBanner: View {
    let streaming: Bool
    let state: BotState?
    let bot: String?
    var stale = false

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 8) {
                Circle().fill(.white).frame(width: 8, height: 8).opacity(streaming ? 1 : 0.5)
                Text(title)
                    .font(Theme.serif(.headline, weight: .bold))
                Spacer(minLength: 0)
                if streaming, let bot {
                    Text(bot == "server" ? "server bot" : "tower bot")
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(Capsule().fill(.white.opacity(0.22)))
                }
            }
            Text(detail)
                .font(.subheadline)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 14).fill(color.opacity(0.92)))
        .animation(.easeInOut(duration: 0.25), value: state?.risk)
    }

    private var risk: String? { streaming ? state?.risk?.lowercased() : nil }

    private var color: Color {
        guard streaming, state != nil, !stale else { return Theme.ink.opacity(0.8) }
        return Theme.riskColor(risk)
    }

    private var title: String {
        guard streaming else { return "Standby" }
        guard state != nil || stale else { return "Connecting to the bot" }
        if stale { return bot == "tower" ? "Tower is detecting" : "Waiting for fresh detections" }
        switch risk {
        case "red": return "RED · Danger"
        case "yellow": return "YELLOW · Caution"
        case "green": return "GREEN · Clear"
        default: return "Watching"
        }
    }

    private var detail: String {
        guard streaming else { return "Tap Start to stream this view to the detection bot." }
        if stale {
            return bot == "tower"
                ? "The server bot handed over; tower dashboards run detection for this feed, so no boxes come back to the phone."
                : "The bot's last result is out of date; still streaming."
        }
        guard let state else { return "Sending frames; waiting for the first detections…" }
        if let p = state.primary { return p.summary }
        if let reason = state.reasons?.first, !reason.isEmpty { return reason }
        return risk == "green" || risk == nil ? "Nothing near the runway." : "Holding the alert while the sky clears."
    }
}
