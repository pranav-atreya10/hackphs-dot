// Tiny H.264 MP4 encoder built on macOS AVFoundation, so recording the film needs no ffmpeg download.
// Reads frames from stdin as [4-byte big-endian length][JPEG or PNG bytes], repeated, and writes a
// YouTube-ready MP4 (H.264 High, yuv420, constant frame rate). "faststart" (moov first, for web streaming) is optional
// because it rewrites the whole file and so needs twice the disk space; YouTube re-encodes uploads and doesn't need it.
// Usage: mp4-encoder <out.mp4> <width> <height> <fps> [bitrate-bits-per-second] [faststart]
import AVFoundation
import CoreGraphics
import Foundation
import ImageIO

func fail(_ message: String) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(1)
}

let args = CommandLine.arguments
guard args.count >= 5, let width = Int(args[2]), let height = Int(args[3]), let fps = Int32(args[4]) else {
  fail("usage: mp4-encoder <out.mp4> <width> <height> <fps> [bitrate]")
}
let bitrate = args.count > 5 ? (Int(args[5]) ?? 12_000_000) : 12_000_000
let outURL = URL(fileURLWithPath: args[1])
try? FileManager.default.removeItem(at: outURL)

guard let writer = try? AVAssetWriter(outputURL: outURL, fileType: .mp4) else { fail("cannot create \(outURL.path)") }
writer.shouldOptimizeForNetworkUse = args.count > 6 && args[6] == "faststart"
let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
  AVVideoCodecKey: AVVideoCodecType.h264,
  AVVideoWidthKey: width,
  AVVideoHeightKey: height,
  AVVideoCompressionPropertiesKey: [
    AVVideoAverageBitRateKey: bitrate,
    AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
    AVVideoExpectedSourceFrameRateKey: fps,
    AVVideoMaxKeyFrameIntervalKey: Int(fps) / 2,   // YouTube recommends a GOP of half the frame rate
    AVVideoAllowFrameReorderingKey: true,
  ] as [String: Any],
  AVVideoColorPropertiesKey: [
    AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
    AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
    AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
  ],
])
input.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
  kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
  kCVPixelBufferWidthKey as String: width,
  kCVPixelBufferHeightKey as String: height,
])
guard writer.canAdd(input) else { fail("cannot add video input") }
writer.add(input)
guard writer.startWriting() else { fail("cannot start writing: \(writer.error?.localizedDescription ?? "?")") }
writer.startSession(atSourceTime: .zero)

let stdin = FileHandle.standardInput
func readExactly(_ count: Int) -> Data? {
  var data = Data()
  while data.count < count {
    let chunk = stdin.readData(ofLength: count - data.count)
    if chunk.isEmpty { return data.isEmpty ? nil : data }
    data.append(chunk)
  }
  return data
}

let colorSpace = CGColorSpaceCreateDeviceRGB()
var frame: Int64 = 0
while let header = readExactly(4), header.count == 4 {
  let length = header.reduce(0) { ($0 << 8) | Int($1) }
  guard let bytes = readExactly(length), bytes.count == length else { fail("truncated frame \(frame)") }
  guard let source = CGImageSourceCreateWithData(bytes as CFData, nil),
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { fail("frame \(frame) is not an image") }
  guard let pool = adaptor.pixelBufferPool else { fail("encoder stopped at frame \(frame): \(writer.error?.localizedDescription ?? "unknown error") (is the disk full?)") }
  var bufferOut: CVPixelBuffer?
  CVPixelBufferPoolCreatePixelBuffer(nil, pool, &bufferOut)
  guard let buffer = bufferOut else { fail("cannot allocate frame buffer") }
  CVPixelBufferLockBaseAddress(buffer, [])
  let context = CGContext(data: CVPixelBufferGetBaseAddress(buffer), width: width, height: height, bitsPerComponent: 8,
                          bytesPerRow: CVPixelBufferGetBytesPerRow(buffer), space: colorSpace,
                          bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
  context?.interpolationQuality = .high
  context?.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
  CVPixelBufferUnlockBaseAddress(buffer, [])
  while !input.isReadyForMoreMediaData { usleep(2000) }
  if !adaptor.append(buffer, withPresentationTime: CMTime(value: frame, timescale: fps)) {
    fail("encoder rejected frame \(frame): \(writer.error?.localizedDescription ?? "?")")
  }
  frame += 1
}

input.markAsFinished()
let done = DispatchSemaphore(value: 0)
writer.finishWriting { done.signal() }
done.wait()
if writer.status != .completed { fail("encoding failed: \(writer.error?.localizedDescription ?? "?")") }
print("wrote \(frame) frames to \(outURL.path)")
