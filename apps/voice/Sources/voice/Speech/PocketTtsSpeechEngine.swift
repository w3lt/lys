import FluidAudio
import Foundation
import Synchronization

/// Speech engine backed by FluidAudio's PocketTTS (English, fp16).
///
/// `warmUp()` downloads the models on first use (about 800 MB) into the
/// models directory and loads them; until it returns, ``isReady`` is `false`
/// and the WebSocket server refuses speech connections. The voice is the
/// cloned voice stored next to the executable as `lys-voice.bin` when one is
/// present, and the preset voice `alba` otherwise.
final class PocketTtsSpeechEngine: SpeechEngine, @unchecked Sendable {
    /// Cloned voice to speak with, or `nil` for the preset voice.
    private let clonedVoice: PocketTtsVoiceData?
    private let manager: PocketTtsManager
    private let ready = Mutex(false)

    /// Creates the engine without touching the models or the network.
    ///
    /// - Parameters:
    ///   - modelsDirectory: Base cache directory for the model files.
    ///   - clonedVoiceFile: Cloned voice exported by `cloneVoiceToFile`, or
    ///     `nil` to speak with the preset voice. A file that exists but
    ///     cannot be decoded is reported and ignored, so a corrupt export
    ///     does not silence Lys.
    init(modelsDirectory: URL, clonedVoiceFile: URL?) {
        let manager = PocketTtsManager(
            defaultVoice: PocketTtsConstants.defaultVoice,
            language: .english,
            directory: modelsDirectory,
            precision: .fp16
        )
        self.manager = manager
        self.clonedVoice = clonedVoiceFile.flatMap { url in
            guard FileManager.default.fileExists(atPath: url.path) else { return nil }
            do {
                return try manager.loadClonedVoice(from: url)
            } catch {
                print("voice: could not load the cloned voice at \(url.path), using preset voice: \(error)")
                return nil
            }
        }
    }

    /// Downloads and loads the models, then reports the engine as ready.
    ///
    /// - Throws: The error that stopped loading; the engine stays not ready.
    func warmUp() async throws {
        try await manager.initialize()
        ready.withLock { $0 = true }
    }

    var isReady: Bool { ready.withLock { $0 } }

    /// Starts a session speaking with the cloned voice when one is loaded,
    /// and with the preset voice otherwise.
    func makeSession() async throws -> any SpeechSession {
        let session: PocketTtsSession
        if let clonedVoice {
            session = try await manager.makeSession(voiceData: clonedVoice)
        } else {
            session = try await manager.makeSession()
        }
        return PocketTtsSpeechSession(session: session)
    }
}

/// Adapts a PocketTTS session to ``SpeechSession``, unwrapping its frames to
/// raw floating-point samples.
private final class PocketTtsSpeechSession: SpeechSession, @unchecked Sendable {
    private let session: PocketTtsSession
    /// Frames of the PocketTTS session as raw `[Float]` samples.
    let frames: AsyncThrowingStream<[Float], any Error>

    init(session: PocketTtsSession) {
        self.session = session
        self.frames = AsyncThrowingStream { continuation in
            let pump = Task {
                do {
                    for try await frame in session.frames {
                        continuation.yield(frame.samples)
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in pump.cancel() }
        }
    }

    func enqueue(_ text: String) { session.enqueue(text) }
    func finish() { session.finish() }
    func cancel() async { await session.cancel() }
}
