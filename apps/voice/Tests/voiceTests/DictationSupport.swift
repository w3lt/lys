import Foundation
@testable import voice

/// Thrown when the fake recognizer fails to load its model.
struct FakeModelLoadError: Error {}

/// Thrown when the fake recognizer fails to hear audio.
struct FakeRecognitionError: Error {}

/// Thrown when the speech engine of a dictation test is asked to speak.
struct SilentSpeechEngineError: Error {}

/// One message of audio the fake recognizer hears as a word: one sample at
/// half of full scale.
let audibleAudio = Data([0x00, 0x40])

/// One message of audio the fake recognizer hears nothing in: one silent
/// sample.
let silentAudio = Data([0x00, 0x00])

/// How a fake recognizer behaves; the default loads, hears, and never waits.
struct FakeRecognizerBehavior {
    /// Whether loading the model fails.
    var failsLoading = false
    /// Whether hearing audio fails.
    var failsRecognition = false
    /// Whether the first audio waits until the test releases it.
    var holdsFirstAudio = false
}

/// Fake recognizer: counts the audible messages of the stream. Its text so
/// far is `heard N`, or empty while nothing was audible, and its finished
/// text is `Heard N.`.
///
/// Concurrency model: serialized. Every property below ``behavior`` is read
/// and written under ``lock``.
final class FakeRecognizer: StreamingRecognizer, @unchecked Sendable {
    /// How the recognizer behaves.
    private let behavior: FakeRecognizerBehavior
    /// Guards every property below.
    private let lock = NSLock()
    /// Audible messages heard since the last reset.
    private var heardCount = 0
    /// How many times the stream was reset.
    private var resets = 0
    /// How many audio calls began, the held one included.
    private var audioCalls = 0
    /// Whether the test released the held first audio.
    private var isFirstAudioReleased = false
    /// The held first audio, while it waits.
    private var heldAudio: CheckedContinuation<Void, Never>?

    /// Creates a recognizer.
    ///
    /// - Parameter behavior: How the recognizer behaves.
    init(_ behavior: FakeRecognizerBehavior = FakeRecognizerBehavior()) {
        self.behavior = behavior
    }

    /// How many times the stream was reset, once per dictation that began
    /// hearing.
    var resetCount: Int {
        lock.withLock { resets }
    }

    /// How many audio calls began, the held one included.
    var startedAudioCount: Int {
        lock.withLock { audioCalls }
    }

    /// Loads nothing.
    ///
    /// - Throws: ``FakeModelLoadError`` when loading fails.
    func loadModels() async throws {
        guard !behavior.failsLoading else { throw FakeModelLoadError() }
    }

    /// Forgets the audible messages counted so far.
    func reset() async {
        lock.withLock {
            heardCount = 0
            resets += 1
        }
    }

    /// Counts the message when it is audible, after the test released it
    /// when it is the held first audio.
    ///
    /// - Parameter samples: The message's samples.
    /// - Returns: `heard N`, or an empty text while nothing was audible.
    /// - Throws: ``FakeRecognitionError`` when recognition fails;
    ///   `CancellationError` when the dictation was cancelled meanwhile.
    func sendAudio(_ samples: [Float]) async throws -> String {
        let isHeld = lock.withLock { () -> Bool in
            audioCalls += 1
            return behavior.holdsFirstAudio && audioCalls == 1 && !isFirstAudioReleased
        }
        if isHeld {
            await waitForRelease()
        }
        try Task.checkCancellation()
        guard !behavior.failsRecognition else { throw FakeRecognitionError() }
        let isAudible = samples.contains(where: { $0 != 0 })
        return lock.withLock {
            heardCount += isAudible ? 1 : 0
            return heardCount == 0 ? "" : "heard \(heardCount)"
        }
    }

    /// Reports the finished text.
    ///
    /// - Returns: `Heard N.`.
    func closeAudio() async throws -> String {
        lock.withLock { "Heard \(heardCount)." }
    }

    /// Lets the held first audio go on.
    func resolveFirstAudio() {
        let held = lock.withLock { () -> CheckedContinuation<Void, Never>? in
            isFirstAudioReleased = true
            defer { heldAudio = nil }
            return heldAudio
        }
        held?.resume()
    }

    /// Waits until the test released the held first audio.
    private func waitForRelease() async {
        await withCheckedContinuation { continuation in
            resumeOrHoldAudio(continuation)
        }
    }

    /// Resumes a waiting first audio when the test already released it, and
    /// holds it until then otherwise.
    ///
    /// - Parameter continuation: The waiting first audio.
    private func resumeOrHoldAudio(_ continuation: CheckedContinuation<Void, Never>) {
        let isReleased = lock.withLock { () -> Bool in
            heldAudio = isFirstAudioReleased ? nil : continuation
            return isFirstAudioReleased
        }
        if isReleased { continuation.resume() }
    }
}

/// Speech engine of the tests that only dictate: ready, and unable to
/// speak.
struct SilentSpeechEngine: SpeechEngine {
    /// Loads nothing.
    func loadModels() async throws {
        // The engine is ready from the start; there is nothing to load.
    }

    /// Always ready, so the handshake depends on the dictation engine alone.
    var isReady: Bool { true }

    /// Refuses to speak.
    ///
    /// - Throws: ``SilentSpeechEngineError``, always.
    func startSession() async throws -> any SpeechSession {
        throw SilentSpeechEngineError()
    }
}

/// Makes a dictation engine whose model is loaded.
///
/// - Parameter recognizer: The fake model.
/// - Returns: The ready engine.
/// - Throws: The recognizer's error when its loading fails.
func startDictationEngine(recognizer: FakeRecognizer) async throws -> DictationEngine {
    let engine = DictationEngine(recognizer: recognizer)
    try await engine.loadModels()
    return engine
}
