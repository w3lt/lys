import Foundation
import Synchronization

/// Tracks the one speech allowed to speak at a time.
///
/// Voice speaks at most one speech at a time: beginning a speech supersedes
/// the previous one, closing its socket with the going-away close code so the
/// backend tears its relay down instead of mistaking it for a finished
/// speech. Ending a speech removes it; ending an already-superseded speech
/// does nothing.
final class SpeechHub: Sendable {
    /// One active speech: its identity and the closure that supersedes it.
    private struct Entry {
        /// Identity of the speech, unique per speech.
        let id: UUID
        /// Closes the speech's socket and stops its synthesis.
        let supersede: @Sendable () -> Void
    }

    private let active = Mutex<Entry?>(nil)

    /// Registers a speech as the active one, superseding the previous one.
    ///
    /// - Parameters:
    ///   - id: Identity of the new speech.
    ///   - supersede: Closure that closes the speech's socket and stops its
    ///     synthesis; called synchronously for the speech being replaced, if
    ///     any.
    func begin(id: UUID, supersede: @escaping @Sendable () -> Void) {
        let previous = active.withLock { current -> Entry? in
            let previous = current
            current = Entry(id: id, supersede: supersede)
            return previous
        }
        previous?.supersede()
    }

    /// Removes the speech `id` if it is the active one.
    ///
    /// - Parameter id: Identity the speech was registered with.
    func end(_ id: UUID) {
        active.withLock { current in
            if current?.id == id {
                current = nil
            }
        }
    }
}
