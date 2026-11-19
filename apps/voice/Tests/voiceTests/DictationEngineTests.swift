import Foundation
import Testing
@testable import voice

/// Reads a dictation's updates until its stream ends.
///
/// - Parameter session: The dictation.
/// - Returns: Every update, in order.
/// - Throws: The error the stream ended with.
private func readUpdates(of session: DictationSession) async throws -> [DictationUpdate] {
    var updates: [DictationUpdate] = []
    for try await update in session.updates {
        updates.append(update)
    }
    return updates
}

/// Checks how the dictation engine feeds one recognizer: in order, one
/// dictation after another, and within a bound.
@Suite("Dictation engine", .timeLimit(.minutes(1)))
struct DictationEngineTests {
    /// Verifies the engine is ready only once its model loaded.
    @Test func isReadyOnceTheModelLoaded() async throws {
        let engine = DictationEngine(recognizer: FakeRecognizer())
        #expect(!engine.isReady)

        try await engine.loadModels()

        #expect(engine.isReady)
    }

    /// Verifies a failed load is thrown and leaves the engine not ready.
    @Test func staysNotReadyWhenTheModelFailsToLoad() async {
        let engine = DictationEngine(recognizer: FakeRecognizer(FakeRecognizerBehavior(failsLoading: true)))

        await #expect(throws: FakeModelLoadError.self) { try await engine.loadModels() }

        #expect(!engine.isReady)
    }

    /// Verifies the text so far is reported in order each time it changed,
    /// and the finished text once the audio closed.
    @Test func reportsEachChangedTextThenTheFinalText() async throws {
        let engine = try await startDictationEngine(recognizer: FakeRecognizer())
        let session = engine.startSession()

        for audio in [audibleAudio, silentAudio, audibleAudio] {
            session.addAudio(try #require(PCMConversion.parseLittleEndianPCM16(audio)))
        }
        session.closeAudio()

        #expect(try await readUpdates(of: session) == [.partial("heard 1"), .partial("heard 2"), .final("Heard 2.")])
    }

    /// Verifies a dictation closed before any audio still reports a final
    /// text, so the client is never left waiting.
    @Test func reportsAFinalTextWithoutAudio() async throws {
        let engine = try await startDictationEngine(recognizer: FakeRecognizer())
        let session = engine.startSession()

        session.closeAudio()

        #expect(try await readUpdates(of: session) == [.final("Heard 0.")])
    }

    /// Verifies a cancelled dictation ends its updates without a final text.
    @Test func cancellingEndsTheUpdatesWithoutAFinalText() async throws {
        let recognizer = FakeRecognizer(FakeRecognizerBehavior(holdsFirstAudio: true))
        let engine = try await startDictationEngine(recognizer: recognizer)
        let session = engine.startSession()
        session.addAudio([0.5])
        try await waitUntil { recognizer.startedAudioCount == 1 }

        session.cancel()
        recognizer.resolveFirstAudio()

        #expect(try await readUpdates(of: session).isEmpty)
    }

    /// Verifies a recognition failure ends the updates with its error.
    @Test func recognitionFailureEndsTheUpdatesWithItsError() async throws {
        let recognizer = FakeRecognizer(FakeRecognizerBehavior(failsRecognition: true))
        let engine = try await startDictationEngine(recognizer: recognizer)
        let session = engine.startSession()

        session.addAudio([0.5])

        await #expect(throws: FakeRecognitionError.self) { try await readUpdates(of: session) }
    }

    /// Verifies audio that waits exactly at the bound is all heard, so the
    /// bound is the most that may wait and not one less.
    @Test func audioAtTheBacklogBoundIsAllHeard() async throws {
        let recognizer = FakeRecognizer(FakeRecognizerBehavior(holdsFirstAudio: true))
        let engine = try await startDictationEngine(recognizer: recognizer)
        let session = engine.startSession()
        session.addAudio([0.5])
        try await waitUntil { recognizer.startedAudioCount == 1 }

        for _ in 1 ... DictationEngine.maximumQueuedMessageCount {
            session.addAudio([0.5])
        }
        recognizer.resolveFirstAudio()
        try await waitUntil { recognizer.startedAudioCount == DictationEngine.maximumQueuedMessageCount + 1 }
        session.closeAudio()

        let heardCount = DictationEngine.maximumQueuedMessageCount + 1
        #expect(try await readUpdates(of: session).last == .final("Heard \(heardCount)."))
    }

    /// Verifies a dictation whose audio waits beyond the bound fails,
    /// instead of holding ever more audio in memory.
    @Test func audioBeyondTheBacklogBoundFailsTheDictation() async throws {
        let recognizer = FakeRecognizer(FakeRecognizerBehavior(holdsFirstAudio: true))
        let engine = try await startDictationEngine(recognizer: recognizer)
        defer { recognizer.resolveFirstAudio() }
        let session = engine.startSession()
        session.addAudio([0.5])
        try await waitUntil { recognizer.startedAudioCount == 1 }

        for _ in 0 ... DictationEngine.maximumQueuedMessageCount {
            session.addAudio([0.5])
        }

        await #expect(throws: AudioBacklogError.self) { try await readUpdates(of: session) }
    }

    /// Verifies a dictation begins hearing only once the dictation before
    /// it ended, and from a cleared stream, because the recognizer holds one
    /// stream.
    @Test func aDictationWaitsForTheOneBeforeItAndStartsCleared() async throws {
        let recognizer = FakeRecognizer(FakeRecognizerBehavior(holdsFirstAudio: true))
        let engine = try await startDictationEngine(recognizer: recognizer)
        let older = engine.startSession()
        older.addAudio([0.5])
        try await waitUntil { recognizer.startedAudioCount == 1 }
        let newer = engine.startSession()
        newer.addAudio([0.5])
        newer.closeAudio()

        try await Task.sleep(for: .milliseconds(100))
        #expect(recognizer.resetCount == 1)
        older.cancel()
        recognizer.resolveFirstAudio()

        #expect(try await readUpdates(of: newer) == [.partial("heard 1"), .final("Heard 1.")])
        #expect(recognizer.resetCount == 2)
    }
}
