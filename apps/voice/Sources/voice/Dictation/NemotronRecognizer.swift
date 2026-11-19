@preconcurrency import AVFoundation
import FluidAudio
import Foundation

/// The audio could not be handed to the model, because the system made no
/// buffer for it.
struct AudioBufferError: Error {}

/// Recognizer backed by FluidAudio's Nemotron streaming model (English,
/// 0.6B), which reads the audio in chunks of 560 ms and writes punctuation
/// and capitals.
///
/// `loadModels()` downloads the model on first use (about 600 MB) into the
/// models directory and loads it.
///
/// Concurrency model: reentrant. The class holds no mutable state; the
/// FluidAudio manager is an actor that owns the stream.
final class NemotronRecognizer: StreamingRecognizer {
    /// Sample rate the model reads, in samples per second.
    private static let sampleRate: Double = 16_000

    /// FluidAudio's manager, which owns the model and the one stream.
    private let manager = StreamingNemotronAsrManager(requestedChunkSize: .ms560)
    /// Base cache directory for the model files.
    private let modelsDirectory: URL

    /// Creates the recognizer without touching the model or the network.
    ///
    /// - Parameter modelsDirectory: Base cache directory for the model files.
    init(modelsDirectory: URL) {
        self.modelsDirectory = modelsDirectory
    }

    /// Downloads the model when it is not cached, and loads it.
    ///
    /// - Throws: The error that stopped the download or the load.
    func loadModels() async throws {
        try await manager.loadModels(to: modelsDirectory)
    }

    /// Clears the manager's stream.
    func reset() async {
        await manager.reset()
    }

    /// Feeds `samples` to the model and decodes every complete chunk.
    ///
    /// - Parameter samples: 16 kHz mono samples within `[-1, 1]`.
    /// - Returns: The whole text decoded since the last ``reset()``.
    /// - Throws: ``AudioBufferError`` when no buffer could be made;
    ///   FluidAudio's error when the model fails; `CancellationError` when
    ///   the calling task was cancelled.
    func addAudio(_ samples: [Float]) async throws -> String {
        if !samples.isEmpty {
            try await manager.appendAudio(try Self.buildBuffer(from: samples))
            try await manager.processBufferedAudio()
        }
        return await manager.getPartialTranscript()
    }

    /// Decodes the audio still buffered, padded to a whole chunk.
    ///
    /// - Returns: The finished text of the stream.
    /// - Throws: FluidAudio's error when the model fails; `CancellationError`
    ///   when the calling task was cancelled.
    func closeAudio() async throws -> String {
        try await manager.finish()
    }

    /// Builds the buffer FluidAudio reads from `samples`.
    ///
    /// - Parameter samples: 16 kHz mono samples; at least one.
    /// - Returns: A buffer in the model's own format, which FluidAudio
    ///   reads without converting.
    /// - Throws: ``AudioBufferError`` when the system made no buffer.
    private static func buildBuffer(from samples: [Float]) throws -> AVAudioPCMBuffer {
        let frameCount = AVAudioFrameCount(samples.count)
        guard
            let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false),
            let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount),
            let channel = buffer.floatChannelData?[0]
        else { throw AudioBufferError() }
        channel.update(from: samples, count: samples.count)
        buffer.frameLength = frameCount
        return buffer
    }
}
