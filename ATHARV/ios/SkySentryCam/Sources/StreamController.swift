import AVFoundation
import CoreImage
import ImageIO
import QuartzCore
import SwiftUI
import UIKit

enum ConnectionStatus: Equatable {
    case idle, connecting, live, retrying, stopped

    var label: String {
        switch self {
        case .idle: return "Ready"
        case .connecting: return "Connecting…"
        case .live: return "Live"
        case .retrying: return "Retrying"
        case .stopped: return "Stopped"
        }
    }

    var color: Color {
        switch self {
        case .idle: return .gray
        case .connecting, .retrying: return Theme.unknown
        case .live: return Theme.riskGreen
        case .stopped: return Theme.riskRed
        }
    }
}

enum ActiveSource { case camera, demo, clip }

/// Latest demo frame, kept separate so only the demo image view redraws at frame rate.
final class DemoFrameStore: ObservableObject {
    @Published var image: CGImage?
}

/// Owns the frame source and the uploader.
///
/// Upload rule: at most one request in flight and at most ~15 frames a second. A frame that arrives
/// while a request is outstanding is dropped, so a slow link lowers the frame rate instead of adding delay.
/// Frames are scaled to 640 px wide and JPEG-encoded (quality 0.6) on the source's background queue.
final class StreamController: ObservableObject {
    @Published private(set) var streaming = false
    @Published private(set) var status: ConnectionStatus = .idle
    @Published private(set) var state: BotState?
    @Published private(set) var bot: String?
    @Published private(set) var stateIsStale = true
    @Published private(set) var framesSent = 0
    @Published private(set) var achievedFps: Double = 0
    @Published private(set) var frameSize: CGSize = .zero
    @Published private(set) var source: ActiveSource = .camera
    @Published private(set) var cameraDenied = false
    @Published var errorMessage: String?

    let demoFrames = DemoFrameStore()
    let camera = CameraSource()
    let clip = DemoClipSource()
    private let demo = DemoSkySource()
    private let api = SkyAPI()
    private let ciContext = CIContext(options: [.cacheIntermediates: false])
    private let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!

    static let targetWidth: CGFloat = 640
    static let minInterval: CFTimeInterval = 0.062      // ≈ 16 fps ceiling; cameras deliver 30 fps -> 15 fps sent
    static let jpegQuality = 0.6

    // Uploader state, shared between the frame queue and URLSession callbacks (guarded by `lock`).
    private let lock = NSLock()
    private var active = false
    private var inFlight = false
    private var lastSend: CFTimeInterval = 0
    private var startTime: CFTimeInterval = 0
    private var pauseUntil: CFTimeInterval = 0
    private var generation = 0
    private var streamID: String?
    private var configured = false
    private var frameTask: URLSessionTask?
    private var settings = StreamSettings.load()
    private var lastSize: CGSize = .zero

    // Main-thread only.
    private var replyTimes: [CFTimeInterval] = []
    private var sourceGeneration = 0
    private var expiry: DispatchWorkItem?

    init() {
        camera.onFrame = { [weak self] image in self?.offer(image) }
        clip.onError = { [weak self] message in if self?.source == .clip { self?.errorMessage = message } }
        camera.onError = { [weak self] message in
            guard let self, self.source == .camera else { return }
            self.stopStreaming()
            self.errorMessage = message
        }
        demo.onFrame = { [weak self] cg in
            guard let self else { return }
            DispatchQueue.main.async { if self.source == .demo { self.demoFrames.image = cg } }
        }
    }

    // MARK: Sources

    /// Picks and starts the frame source. The preview runs whenever the camera screen is open;
    /// frames are only uploaded while streaming.
    func activate(_ preference: SourcePreference) {
        if preference == .clip { switchTo(.clip); return }
        switchTo(preference == .demo ? .demo : .camera)
    }

    func switchTo(_ newSource: ActiveSource) {
        stopStreaming()
        sourceGeneration += 1
        let gen = sourceGeneration
        camera.stop()
        demo.stop()
        clip.stop()
        source = newSource
        cameraDenied = false
        errorMessage = nil
        if newSource == .clip {
            let s = StreamSettings.load()
            let file = UserDefaults.standard.string(forKey: SettingKey.demoClip) ?? SettingDefaults.demoClip
            guard let base = SkyAPI.baseURL(s.serverURL), !file.contains("/"), file.hasSuffix(".mp4") else {
                errorMessage = "Choose a demo video from the library and check the server address."
                return
            }
            clip.start(base.appendingPathComponent("clips").appendingPathComponent(file))
            return
        }
        if newSource == .demo {
            demo.start()
            return
        }
        guard CameraSource.isAvailable else {
            cameraDenied = true
            errorMessage = "No rear camera is available. You can choose a local demo preview."
            return
        }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            camera.start()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { granted in
                DispatchQueue.main.async {
                    guard self.source == .camera, gen == self.sourceGeneration else { return }
                    if granted { self.camera.start() } else { self.cameraWasDenied() }
                }
            }
        default:
            cameraWasDenied()
        }
    }

    private func cameraWasDenied() {
        cameraDenied = true
        errorMessage = "Camera access is turned off for SkySentry. Allow it in Settings, or use the demo sky."
    }

    func setDemoPortrait(_ portrait: Bool) { demo.portrait = portrait }

    /// Camera screen closed: stop everything.
    func shutdown() {
        stopStreaming()
        sourceGeneration += 1
        camera.stop()
        demo.stop()
        clip.stop()
    }

    // MARK: Streaming

    func startStreaming() {
        guard !streaming else { return }
        guard source == .camera else {
            errorMessage = "Demo previews are local only and cannot be streamed to the tower."
            return
        }
        let s = StreamSettings.load()
        guard SkyAPI.baseURL(s.serverURL) != nil else {
            errorMessage = APIError.badURL.message(server: s.serverURL)
            return
        }
        guard s.deviceId != nil else {
            errorMessage = APIError.deviceIdentity.message(server: s.serverURL)
            return
        }
        guard CameraSource.isAvailable, !cameraDenied, AVCaptureDevice.authorizationStatus(for: .video) == .authorized else {
            errorMessage = "A rear camera with camera access is required to stream."
            return
        }
        let id = UUID().uuidString.lowercased()
        lock.lock()
        active = true
        inFlight = false
        lastSend = 0
        pauseUntil = 0
        startTime = CACurrentMediaTime()
        generation += 1
        streamID = id
        configured = false
        settings = s
        let gen = generation
        lock.unlock()

        streaming = true
        status = .connecting
        framesSent = 0
        achievedFps = 0
        replyTimes = []
        state = nil
        bot = "starting"
        stateIsStale = true
        errorMessage = nil
        UIApplication.shared.isIdleTimerDisabled = true
        sendConfig(s, id: id, gen: gen)
    }

    func stopStreaming() {
        lock.lock()
        let id = streamID
        let s = settings
        streamID = nil
        active = false
        generation += 1
        configured = false
        frameTask?.cancel()
        frameTask = nil
        lock.unlock()
        if let id { api.sendStop(s, streamID: id) }
        if streaming { status = .idle }
        streaming = false
        achievedFps = 0
        expiry?.cancel()
        state = nil
        bot = nil
        stateIsStale = true
        UIApplication.shared.isIdleTimerDisabled = false
    }

    /// Settings were edited: pick them up and tell the server.
    func settingsChanged() {
        let preference = SourcePreference(rawValue: UserDefaults.standard.string(forKey: SettingKey.sourcePref) ?? "auto") ?? .auto
        let desired: ActiveSource = preference == .clip ? .clip : preference == .demo ? .demo : .camera
        if desired != source || desired == .clip { switchTo(desired) }
        // Settings, including credentials and airport, are fixed for the duration of a stream.
        if streaming { stopStreaming() }
    }

    private func isCurrent(_ gen: Int) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return gen == generation && active
    }

    private func sendConfig(_ s: StreamSettings, id: String, gen: Int) {
        let api = self.api
        api.sendConfig(s, streamID: id) { [weak self] result in
            DispatchQueue.main.async {
                guard let self, self.isCurrent(gen) else {
                    if case .success = result { api.sendStop(s, streamID: id) }
                    return
                }
                switch result {
                case .success:
                    self.lock.lock()
                    self.configured = true
                    self.lock.unlock()
                case .failure(let e):
                    self.fail(e, server: s.serverURL)
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
                        guard let self, self.isCurrent(gen) else { return }
                        self.sendConfig(s, id: id, gen: gen)
                    }
                }
            }
        }
    }

    /// Called on the rear-camera background queue; demo frames never enter the uploader.
    private func offer(_ image: CIImage) {
        let now = CACurrentMediaTime()
        let extent = image.extent
        guard extent.width > 0, extent.height > 0 else { return }
        // Bound the long edge: portrait frames otherwise contain over three times as many pixels.
        let scale = min(1, Self.targetWidth / max(extent.width, extent.height))
        let outSize = CGSize(width: (extent.width * scale).rounded(), height: (extent.height * scale).rounded())

        lock.lock()
        if outSize != lastSize {
            lastSize = outSize
            DispatchQueue.main.async { self.frameSize = outSize }
        }
        guard active, configured, let id = streamID, !inFlight, now - lastSend >= Self.minInterval, now >= pauseUntil else {
            lock.unlock()
            return
        }
        inFlight = true
        lastSend = now
        let t = now - startTime
        let s = settings
        let gen = generation
        lock.unlock()

        guard let jpeg = encode(image, scale: scale, size: outSize) else {
            lock.lock(); if gen == generation { inFlight = false }; lock.unlock()
            return
        }
        lock.lock()
        defer { lock.unlock() }
        guard active, gen == generation else { return }
        frameTask = api.sendFrame(jpeg, time: t, settings: s, streamID: id) { [weak self] result in
            self?.handle(result, gen: gen, settings: s, id: id, sentTime: t)
        }
    }

    private func encode(_ image: CIImage, scale: CGFloat, size: CGSize) -> Data? {
        var img = image
        if scale < 1 { img = img.transformed(by: CGAffineTransform(scaleX: scale, y: scale)) }
        img = img.transformed(by: CGAffineTransform(translationX: -img.extent.origin.x, y: -img.extent.origin.y))
            .cropped(to: CGRect(origin: .zero, size: size))
        let quality = CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String)
        return ciContext.jpegRepresentation(of: img, colorSpace: colorSpace, options: [quality: Self.jpegQuality])
    }

    private func handle(_ result: Result<FrameReply, APIError>, gen: Int, settings s: StreamSettings, id: String, sentTime: Double) {
        let now = CACurrentMediaTime()
        lock.lock()
        guard gen == generation else { lock.unlock(); return }
        inFlight = false
        frameTask = nil
        if case .failure(let e) = result {
            if case .http(409, _) = e { configured = false }
            pauseUntil = now + 1.0
        }
        lock.unlock()

        DispatchQueue.main.async {
            guard self.isCurrent(gen) else { return }
            switch result {
            case .success(let reply):
                self.framesSent += 1
                self.replyTimes.append(now)
                self.replyTimes.removeAll { now - $0 > 2.0 }
                if self.replyTimes.count >= 2, let first = self.replyTimes.first, now > first {
                    self.achievedFps = Double(self.replyTimes.count - 1) / (now - first)
                }
                self.expiry?.cancel()
                let bot = reply.bot ?? "starting"
                self.bot = ["starting", "server"].contains(bot) ? bot : "unavailable"
                let age = Date().timeIntervalSince1970 * 1000 - (reply.at ?? .infinity)
                if bot == "server", let state = reply.state, let stateTime = state.t,
                   let remaining = reply.remaining_ms, remaining.isFinite,
                   age >= 0, min(3000, remaining) > age, stateTime <= sentTime {
                    self.state = state
                    self.stateIsStale = false
                    let expiry = DispatchWorkItem { [weak self] in
                        guard let self, self.isCurrent(gen) else { return }
                        self.state = nil
                        self.stateIsStale = true
                    }
                    self.expiry = expiry
                    DispatchQueue.main.asyncAfter(deadline: .now() + (min(3000, remaining) - age) / 1000, execute: expiry)
                } else {
                    self.state = nil
                    self.stateIsStale = true
                }
                self.status = .live
                self.errorMessage = nil
            case .failure(let e):
                self.expiry?.cancel()
                self.state = nil
                self.stateIsStale = true
                if case .http(409, _) = e {
                    self.bot = "starting"
                    self.status = .connecting
                    self.sendConfig(s, id: id, gen: gen)
                } else {
                    self.fail(e, server: s.serverURL)
                }
            }
        }
    }

    private func fail(_ e: APIError, server: String) {
        errorMessage = e.message(server: server)
        switch e {
        case .unauthorized, .badURL, .insecure, .deviceIdentity:
            stopStreaming()
            status = .stopped
        default:
            status = .retrying
        }
    }
}
