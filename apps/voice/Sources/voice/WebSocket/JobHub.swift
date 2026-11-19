import Foundation
import Synchronization

/// Tracks the one job of a kind allowed to run at a time.
///
/// voice speaks at most one speech and listens to at most one dictation at
/// a time, each kind under its own hub: beginning a job supersedes the
/// previous one of its kind, closing its socket with the going-away close
/// code so the backend tears its relay down instead of mistaking it for a
/// finished job. Ending a job removes it; ending an already-superseded job
/// does nothing.
///
/// Concurrency model: serialized. The active job is read and replaced under
/// its `Mutex`; the superseded job's closure runs after the lock is
/// released, so it may call back into the hub.
final class JobHub: Sendable {
    /// One active job: its identity and the closure that supersedes it.
    private struct Entry {
        /// Identity of the job, unique per job.
        let id: UUID
        /// Closes the job's socket and stops its work.
        let supersede: @Sendable () -> Void
    }

    /// The job allowed to run, if any.
    private let active = Mutex<Entry?>(nil)

    /// Registers a job as the active one, superseding the previous one.
    ///
    /// - Parameters:
    ///   - id: Identity of the new job.
    ///   - supersede: Closure that closes the job's socket and stops its
    ///     work; called synchronously for the job being replaced, if any.
    func register(id: UUID, supersede: @escaping @Sendable () -> Void) {
        let previous = active.withLock { current -> Entry? in
            let previous = current
            current = Entry(id: id, supersede: supersede)
            return previous
        }
        previous?.supersede()
    }

    /// Removes the job `id` if it is the active one.
    ///
    /// - Parameter id: Identity the job was registered with.
    func remove(_ id: UUID) {
        active.withLock { current in
            current = current?.id == id ? nil : current
        }
    }
}
