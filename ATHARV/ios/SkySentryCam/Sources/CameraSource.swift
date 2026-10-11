import AVFoundation
import CoreImage
import SwiftUI
import UIKit

/// Rear wide camera at 1280x720. Frames arrive upright (horizon-level) on a background queue.
final class CameraSource: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    let session = AVCaptureSession()
    /// Called on the video queue for every frame.
    var onFrame: ((CIImage) -> Void)?
    /// Called on the main queue when the camera can't be set up.
    var onError: ((String) -> Void)?

    private let sessionQueue = DispatchQueue(label: "skysentry.camera.session")
    private let videoQueue = DispatchQueue(label: "skysentry.camera.video", qos: .userInitiated)
    private let output = AVCaptureVideoDataOutput()
    private let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back)
    private var configured = false
    private var coordinator: AVCaptureDevice.RotationCoordinator?
    private var observations: [NSKeyValueObservation] = []
    private weak var previewLayer: AVCaptureVideoPreviewLayer?

    static var isAvailable: Bool {
        AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) != nil
    }

    func start() {
        sessionQueue.async {
            if !self.configured { self.configure() }
            guard self.configured else { return }
            if !self.session.isRunning { self.session.startRunning() }
            DispatchQueue.main.async { self.applyRotation() }
        }
    }

    func stop() {
        sessionQueue.async {
            if self.session.isRunning { self.session.stopRunning() }
        }
    }

    private func configure() {
        guard let device else { return report("This device has no rear camera. Use the demo sky instead.") }
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        session.sessionPreset = session.canSetSessionPreset(.hd1280x720) ? .hd1280x720 : .high
        do {
            let input = try AVCaptureDeviceInput(device: device)
            guard session.canAddInput(input) else { return report("The camera is busy in another app.") }
            session.addInput(input)
        } catch {
            return report("Couldn't open the camera: \(error.localizedDescription)")
        }
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
        output.alwaysDiscardsLateVideoFrames = true
        output.setSampleBufferDelegate(self, queue: videoQueue)
        guard session.canAddOutput(output) else { return report("Couldn't read frames from the camera.") }
        session.addOutput(output)
        configured = true
    }

    private func report(_ message: String) {
        DispatchQueue.main.async { self.onError?(message) }
    }

    /// Hooks the preview layer up to a rotation coordinator so preview and frames stay level in any orientation.
    func attach(_ layer: AVCaptureVideoPreviewLayer) {
        previewLayer = layer
        guard let device else { return }
        let c = AVCaptureDevice.RotationCoordinator(device: device, previewLayer: layer)
        coordinator = c
        observations = [
            c.observe(\.videoRotationAngleForHorizonLevelPreview, options: [.new]) { [weak self] _, _ in
                DispatchQueue.main.async { self?.applyRotation() }
            },
            c.observe(\.videoRotationAngleForHorizonLevelCapture, options: [.new]) { [weak self] _, _ in
                DispatchQueue.main.async { self?.applyRotation() }
            },
        ]
        applyRotation()
    }

    private func applyRotation() {
        guard let c = coordinator else { return }
        let previewAngle = c.videoRotationAngleForHorizonLevelPreview
        if let conn = previewLayer?.connection, conn.isVideoRotationAngleSupported(previewAngle) {
            conn.videoRotationAngle = previewAngle
        }
        let captureAngle = c.videoRotationAngleForHorizonLevelCapture
        sessionQueue.async {
            if let conn = self.output.connection(with: .video), conn.isVideoRotationAngleSupported(captureAngle) {
                conn.videoRotationAngle = captureAngle
            }
        }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let buffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        onFrame?(CIImage(cvPixelBuffer: buffer))
    }
}

/// UIView whose backing layer is the camera preview.
final class PreviewUIView: UIView {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
    var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
}

struct CameraPreview: UIViewRepresentable {
    let camera: CameraSource
    let fill: Bool

    func makeUIView(context: Context) -> PreviewUIView {
        let view = PreviewUIView()
        view.backgroundColor = .black
        view.previewLayer.session = camera.session
        view.previewLayer.videoGravity = fill ? .resizeAspectFill : .resizeAspect
        camera.attach(view.previewLayer)
        return view
    }

    func updateUIView(_ view: PreviewUIView, context: Context) {
        view.previewLayer.videoGravity = fill ? .resizeAspectFill : .resizeAspect
    }
}
