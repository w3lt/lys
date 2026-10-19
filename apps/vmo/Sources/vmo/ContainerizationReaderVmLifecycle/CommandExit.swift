import Synchronization

/// Owns the exit of one VM's command, once it is known, and the waits for it,
/// to let any number of callers wait for the exit, each on its own, while
/// guaranteeing that every wait ends exactly once: with the exit, or with
/// `CancellationError` when its caller is cancelled first.
///
/// Invariant: until ``resolve(with:)``, the state keeps every wait that has
/// begun and hasn't been cancelled; from then on it keeps the exit and no
/// wait.
///
/// Lifecycle: pending → resolved. ``resolve(with:)`` moves it once; a wait
/// that begins after that gets the exit at once.
///
/// It owns no resource. It neither runs nor stops the command: whoever
/// resolves it waits for the command.
///
/// Concurrency model: concurrent. Any task can wait, be cancelled, or
/// resolve the exit; one mutex guards the waits and the exit, and waits are
/// resumed after it is released.
final class CommandExit: Sendable {
    /// The waits for the exit, or the exit once it is resolved.
    private let state = Mutex(CommandExitState())

    /// Creates the exit of a command that hasn't exited: pending, with no
    /// waits.
    init() {}

    /// Waits until the command's exit is resolved, and returns it.
    ///
    /// Each call waits on its own. Cancelling the caller ends only that
    /// caller's wait, at once; the other waits and the exit stay as they
    /// are. There is no time limit.
    ///
    /// - Returns: The exit that ``resolve(with:)`` gave, the same for every
    ///   wait: what the command wrote and its exit code, or why waiting for
    ///   the command failed.
    /// - Throws: `CancellationError` when the caller is cancelled before the
    ///   exit reaches its wait, including before the wait began, also when
    ///   the exit is already resolved.
    func waitForExit() async throws -> Result<CommandOutput, any Error> {
        let waitId = state.withLock { $0.createWaitId() }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                addWait(CommandExitWait(id: waitId, continuation: continuation))
            }
        } onCancel: {
            cancelWait(waitId)
        }
    }

    /// Resolves the exit, which ends every wait for it with `exit`.
    ///
    /// - Parameter exit: What the command wrote and its exit code, or why
    ///   waiting for the command failed.
    /// - Precondition: The exit isn't resolved yet: a command exits once.
    func resolve(with exit: Result<CommandOutput, any Error>) {
        let endedWaits = state.withLock { $0.resolve(with: exit) }
        endedWaits.forEach { $0.continuation.resume(returning: exit) }
    }

    /// Keeps a wait until the exit is resolved, or ends it at once when the
    /// exit is resolved or its task is cancelled.
    ///
    /// The cancellation check and the keeping share the mutex with
    /// ``cancelWait(_:)``, so a cancellation is never missed: it either
    /// comes before, and is seen here, or after, and finds the wait kept.
    ///
    /// - Parameter wait: The wait that is starting.
    private func addWait(_ wait: CommandExitWait) {
        let start = state.withLock { $0.addWait(wait, isTaskCancelled: Task.isCancelled) }
        switch start {
        case .waiting:
            return // resolve(with:) or cancelWait(_:) resumes it.
        case .exitResolved(let exit):
            wait.continuation.resume(returning: exit)
        case .cancelled:
            wait.continuation.resume(throwing: CancellationError())
        }
    }

    /// Ends a wait whose task was cancelled with `CancellationError`, when it
    /// is still waiting.
    ///
    /// - Parameter waitId: Id of the wait.
    private func cancelWait(_ waitId: Int) {
        let wait = state.withLock { $0.removeWait(waitId) }
        wait?.continuation.resume(throwing: CancellationError())
    }
}

/// A wait for a ``CommandExit``.
private struct CommandExitWait: Sendable {
    /// Id that tells the wait from every other wait for the same exit.
    let id: Int
    /// The suspended waiter.
    let continuation: CheckedContinuation<Result<CommandOutput, any Error>, any Error>
}

/// How a wait given to a ``CommandExit`` starts.
private enum CommandExitWaitStart {
    /// It waits for the exit.
    case waiting
    /// The exit is resolved, so the wait ends now with it.
    case exitResolved(Result<CommandOutput, any Error>)
    /// Its task was cancelled, so it ends now with `CancellationError`.
    case cancelled
}

/// How far a ``CommandExit`` has got.
private enum CommandExitPhase {
    /// The exit isn't resolved; these waits are kept, keyed by id.
    case pending(waits: [Int: CommandExitWait])
    /// The exit is resolved; no wait is kept.
    case resolved(Result<CommandOutput, any Error>)
}

/// Owns the waits of a ``CommandExit`` and its exit, to give it one value to
/// guard, while guaranteeing that no wait is kept once the exit is resolved.
///
/// Concurrency model: single-owner. Only its command exit's mutex reaches it.
private struct CommandExitState {
    /// The kept waits, or the exit.
    private var phase = CommandExitPhase.pending(waits: [:])
    /// Id the next wait gets.
    private var nextWaitId = 0

    /// Creates an id that no other wait for the exit has.
    ///
    /// - Returns: The id.
    mutating func createWaitId() -> Int {
        defer { nextWaitId += 1 }
        return nextWaitId
    }

    /// Keeps a wait, unless it must end at once.
    ///
    /// - Parameters:
    ///   - wait: The wait that is starting.
    ///   - isTaskCancelled: Whether the wait's task is cancelled.
    /// - Returns: How the wait starts; only a waiting one was kept.
    mutating func addWait(_ wait: CommandExitWait, isTaskCancelled: Bool) -> CommandExitWaitStart {
        guard !isTaskCancelled else {
            return .cancelled
        }
        switch phase {
        case .pending(var waits):
            waits[wait.id] = wait
            phase = .pending(waits: waits)
            return .waiting
        case .resolved(let exit):
            return .exitResolved(exit)
        }
    }

    /// Removes a kept wait.
    ///
    /// - Parameter waitId: Id of the wait.
    /// - Returns: The wait, or `nil` when it isn't kept, because it has
    ///   ended or never waited.
    mutating func removeWait(_ waitId: Int) -> CommandExitWait? {
        guard case .pending(var waits) = phase, let wait = waits.removeValue(forKey: waitId) else {
            return nil
        }
        phase = .pending(waits: waits)
        return wait
    }

    /// Resolves the exit and removes every kept wait.
    ///
    /// - Parameter exit: The command's exit.
    /// - Returns: The removed waits, for the command exit to resume.
    /// - Precondition: The exit isn't resolved yet.
    mutating func resolve(with exit: Result<CommandOutput, any Error>) -> [CommandExitWait] {
        guard case .pending(let waits) = phase else {
            preconditionFailure("A command's exit is resolved once")
        }
        phase = .resolved(exit)
        return Array(waits.values)
    }
}
