import Foundation
import Testing
@testable import voice

/// Checks that only one speech speaks at a time.
@Suite("Speech hub")
struct SpeechHubTests {
    /// Records the supersede calls the hub makes, in order.
    ///
    /// Concurrency model: serialized. The calls are read and written under
    /// ``lock``.
    private final class SupersedeRecorder: @unchecked Sendable {
        /// Guards ``recorded``.
        private let lock = NSLock()
        /// Identities of the superseded speeches, in order.
        private var recorded: [UUID] = []

        /// Identities of the superseded speeches, in order.
        var calls: [UUID] {
            lock.withLock { recorded }
        }

        /// Records that the speech `id` was superseded.
        ///
        /// - Parameter id: Identity of the superseded speech.
        func add(_ id: UUID) {
            lock.withLock { recorded.append(id) }
        }
    }

    /// Verifies a second speech supersedes the first, exactly once.
    @Test("Beginning a speech supersedes the previous one")
    func supersedesPreviousSpeech() {
        let hub = SpeechHub()
        let recorder = SupersedeRecorder()
        let first = UUID()
        let second = UUID()

        hub.register(id: first) { recorder.add(first) }
        hub.register(id: second) { recorder.add(second) }

        #expect(recorder.calls == [first])
    }

    /// Verifies ending the active speech removes it without superseding it.
    @Test("Ending the active speech clears it")
    func endClearsActiveSpeech() {
        let hub = SpeechHub()
        let recorder = SupersedeRecorder()
        let first = UUID()
        let second = UUID()

        hub.register(id: first) { recorder.add(first) }
        hub.remove(first)
        hub.register(id: second) { recorder.add(second) }

        #expect(recorder.calls.isEmpty)
    }

    /// Verifies ending a speech that was already superseded does nothing, so
    /// it cannot remove the speech that replaced it.
    @Test("Ending a superseded speech does not clear the active one")
    func endingSupersededSpeechDoesNothing() {
        let hub = SpeechHub()
        let recorder = SupersedeRecorder()
        let first = UUID()
        let second = UUID()
        let third = UUID()

        hub.register(id: first) { recorder.add(first) }
        hub.register(id: second) { recorder.add(second) }
        hub.remove(first)
        hub.remove(second)
        hub.register(id: third) { recorder.add(third) }

        #expect(recorder.calls == [first])
    }
}
