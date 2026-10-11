import AVFoundation
import CoreImage
import SwiftUI
import UIKit

/// Replays real demonstration footage through the same uploader as the rear camera.
final class DemoClipSource: NSObject {
    let player = AVPlayer()
    var onFrame: ((CIImage) -> Void)?
    var onError: ((String) -> Void)?
    private var output: AVPlayerItemVideoOutput?
    private var displayLink: CADisplayLink?
    private var ended: NSObjectProtocol?
    private var observation: NSKeyValueObservation?
    private let queue = DispatchQueue(label: "skysentry.demo.video", qos: .userInitiated)
    private let available = DispatchSemaphore(value: 1)

    func start(_ url: URL) {
        stop()
        let item = AVPlayerItem(url: url)
        let out = AVPlayerItemVideoOutput(pixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
        item.add(out)
        output = out
        player.replaceCurrentItem(with: item)
        player.isMuted = true
        observation = item.observe(\.status, options: [.new]) { [weak self] item, _ in
            DispatchQueue.main.async {
                if item.status == .failed { self?.onError?("Could not play this demo. Check the server address and choose an MP4 clip.") }
            }
        }
        ended = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self] _ in
            self?.player.seek(to: .zero) { [weak self] _ in self?.player.play() }
        }
        let link = CADisplayLink(target: self, selector: #selector(tick))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 15, maximum: 30, preferred: 30)
        link.add(to: .main, forMode: .common)
        displayLink = link
        player.play()
    }

    func stop() {
        displayLink?.invalidate(); displayLink = nil
        player.pause(); player.replaceCurrentItem(with: nil)
        if let ended { NotificationCenter.default.removeObserver(ended) }
        ended = nil; observation = nil; output = nil
    }

    @objc private func tick() {
        guard let output else { return }
        let time = output.itemTime(forHostTime: CACurrentMediaTime())
        guard output.hasNewPixelBuffer(forItemTime: time), available.wait(timeout: .now()) == .success else { return }
        guard let buffer = output.copyPixelBuffer(forItemTime: time, itemTimeForDisplay: nil) else { available.signal(); return }
        queue.async { [weak self] in
            guard let self else { return }
            self.onFrame?(CIImage(cvPixelBuffer: buffer))
            self.available.signal()
        }
    }
}

final class ClipPreviewUIView: UIView {
    override class var layerClass: AnyClass { AVPlayerLayer.self }
    var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
}

struct DemoClipPreview: UIViewRepresentable {
    let player: AVPlayer
    let fill: Bool
    func makeUIView(context: Context) -> ClipPreviewUIView {
        let view = ClipPreviewUIView()
        view.backgroundColor = .black
        view.playerLayer.player = player
        return view
    }
    func updateUIView(_ view: ClipPreviewUIView, context: Context) {
        view.playerLayer.player = player
        view.playerLayer.videoGravity = fill ? .resizeAspectFill : .resizeAspect
    }
}

struct DemoClip: Decodable, Identifiable {
    var file: String
    var title: String
    var expect: String
    var credit: String
    var id: String { file }
}

struct DemoLibraryView: View {
    let serverURL: String
    var onSelect: (DemoClip) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var clips: [DemoClip] = []
    @State private var error: String?
    @State private var loading = true

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("Real recorded footage. Selecting a clip streams it through the same detection model as the live camera.")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                if loading { ProgressView("Loading demo library…") }
                if let error { Text(error).foregroundStyle(.red) }
                ForEach(clips) { clip in
                    Button {
                        onSelect(clip); dismiss()
                    } label: {
                        VStack(alignment: .leading, spacing: 5) {
                            Label(clip.title, systemImage: "play.circle.fill").font(.headline)
                            Text(clip.expect).font(.subheadline).foregroundStyle(.secondary)
                            Text(clip.credit).font(.caption2).foregroundStyle(.secondary)
                        }.padding(.vertical, 5)
                    }
                }
            }
            .navigationTitle("Demo videos")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            .task {
                defer { loading = false }
                guard let base = SkyAPI.baseURL(serverURL) else { error = "Set the server address in Setup first."; return }
                do {
                    let (data, response) = try await URLSession.shared.data(from: base.appendingPathComponent("clips/clips.json"))
                    guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
                    clips = try JSONDecoder().decode([DemoClip].self, from: data).filter { $0.file.hasSuffix(".mp4") && !$0.file.contains("/") }
                    if clips.isEmpty { error = "No iPhone-compatible demo clips are available on this server yet." }
                } catch { self.error = "Could not load demos. Keep this phone on the server's Wi-Fi and try again." }
            }
        }
    }
}
