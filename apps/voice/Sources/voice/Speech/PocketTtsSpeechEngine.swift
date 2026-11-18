import FluidAudio
import Foundation
import Synchronization

/// Speech engine backed by FluidAudio's PocketTTS (English, fp16).
///
/// `loadModels()` downloads the models on first use (about 800 MB) into the
/// models directory and loads them; until it returns, ``isReady`` is `false`
/// and the WebSocket server refuses speech connections. The voice is the
/// cloned voice stored next to the executable as `lys-voice.bin` when one is
/// present, and the preset voice `alba` otherwise.
///
/// Concurrency model: reentrant. The readiness flag is the only state this
/// class mutates, under its `Mutex`; the PocketTTS manager serializes its
/// own model loading and sessions.
final class PocketTtsSpeechEngine: SpeechEngine, @unchecked Sendable {
    /// Cloned voice to speak with, or `nil` for the preset voice.
    private let clonedVoice: PocketTtsVoiceData?
    /// FluidAudio's manager, which owns the models and makes sessions.
    private let manager: PocketTtsManager
    /// Whether ``loadModels()`` loaded the models.
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
    func loadModels() async throws {
        try await manager.initialize()
        ready.withLock { $0 = true }
    }

    /// Whether the models are loaded.
    var isReady: Bool { ready.withLock { $0 } }

    /// Starts a session speaking with the cloned voice when one is loaded,
    /// and with the preset voice otherwise.
    func startSession() async throws -> any SpeechSession {
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
///
/// Concurrency model: reentrant. The class holds no mutable state; its
/// calls forward to the PocketTTS session, and one task forwards its frames.
private final class PocketTtsSpeechSession: SpeechSession, @unchecked Sendable {
    /// The adapted PocketTTS session.
    private let session: PocketTtsSession
    /// Frames of the PocketTTS session as raw `[Float]` samples.
    let frames: AsyncThrowingStream<[Float], any Error>

    /// Adapts `session`, starting the task that forwards its frames; ending
    /// the frame stream cancels that task. A synthesis failure ends the
    /// stream with its error, which the speech connection logs.
    ///
    /// - Parameter session: Session that has not produced frames yet.
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

    /// Queues one sentence on the PocketTTS session.
    ///
    /// - Parameter text: Sentence to speak.
    func addText(_ text: String) { session.enqueue(text) }

    /// Tells the PocketTTS session that no more text follows.
    func closeText() { session.finish() }

    /// Cancels the PocketTTS session, which ends its frames.
    func cancel() async { await session.cancel() }
}
