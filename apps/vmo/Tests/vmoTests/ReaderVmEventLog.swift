import Synchronization
@testable import vmo

/// One thing that happened in a test of an ``InMemoryReaderVmLifecycle`` or
/// of a ``CommandExit``: a call to the lifecycle, the end of a call that can
/// suspend, something its VMs did, the start or end of a wait for a command
/// exit, or the end of the read under test.
enum ReaderVmEvent: Equatable, Sendable {
    /// ``ReaderVmLifecycle/createVm(imageReference:arguments:)`` was called.
    case createVm(imageReference: ImageReference, arguments: [String])
    /// ``ReaderVmLifecycle/startVm(containerId:)`` was called.
    case startVm(containerId: ContainerId)
    /// A call to ``ReaderVmLifecycle/startVm(containerId:)`` returned or
    /// threw.
    case startEnded(containerId: ContainerId)
    /// ``ReaderVmLifecycle/waitForCommandExit(containerId:)`` was called. In
    /// a test of a ``CommandExit``, a wait for the exit began, and the id
    /// names the waited command, not a VM.
    case waitForCommandExit(containerId: ContainerId)
    /// ``ReaderVmLifecycle/deleteVm(containerId:)`` was called, from a task
    /// that was or wasn't cancelled.
    case deleteVm(containerId: ContainerId, isCallerCancelled: Bool)
    /// The VM's command exited on its own, because the test resolved it.
    case commandExited(containerId: ContainerId)
    /// A wait for the VM's command returned or threw. In a test of a
    /// ``CommandExit``, a wait for the exit did.
    case waitEnded(containerId: ContainerId)
    /// The read under test returned or threw. The test that runs the read
    /// records it, not the lifecycle.
    case readEnded
}

/// Owns the events of one test of an ``InMemoryReaderVmLifecycle`` or of a
/// ``CommandExit`` in the order they happened, to let the test assert them
/// and wait for them, while guaranteeing that every wait ends once its events
/// are added or its task is cancelled.
///
/// Concurrency model: concurrent. Any task can add events, read them, or wait
/// for them; one mutex guards the events and the waits, and waits are resumed
/// after it is released.
final class ReaderVmEventLog: Sendable {
    /// The events and the waits for them.
    private let entries = Mutex(ReaderVmEventEntries())

    /// Creates a log with no events.
    init() {}

    /// The events added so far, oldest first.
    var events: [ReaderVmEvent] {
        entries.withLock { $0.events }
    }

    /// Adds an event, ending every wait that the log then has all its events
    /// for.
    ///
    /// - Parameter event: What happened.
    func addEvent(_ event: ReaderVmEvent) {
        let endedWaits = entries.withLock { $0.addEvent(event) }
        endedWaits.forEach { $0.continuation.resume() }
    }

    /// Suspends until the log has `event` `count` times, which may already be
    /// the case.
    ///
    /// A test bounds this wait with its time limit, which cancels it.
    ///
    /// - Parameters:
    ///   - event: The event to wait for.
    ///   - count: How many times the log must have it; once by default.
    /// - Throws: `CancellationError` when the task is cancelled before the
    ///   log has the events.
    /// - Precondition: `count` is at least 1.
    func waitForEvent(_ event: ReaderVmEvent, count: Int = 1) async throws {
        precondition(count >= 1, "A wait for events waits for at least one")
        let waitId = entries.withLock { $0.createWaitId() }
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                addEventWait(EventWait(id: waitId, event: event, count: count, continuation: continuation))
            }
        } onCancel: {
            cancelEventWait(waitId)
        }
    }

    /// Keeps a wait until its events are added, or ends it at once when they
    /// are there or its task is cancelled.
    ///
    /// The cancellation check and the keeping share the mutex with
    /// ``cancelEventWait(_:)``, so a cancellation is never missed.
    ///
    /// - Parameter wait: The wait that is starting.
    private func addEventWait(_ wait: EventWait) {
        let start = entries.withLock { $0.addWait(wait, isTaskCancelled: Task.isCancelled) }
        switch start {
        case .waiting:
            return // addEvent(_:) or cancelEventWait(_:) resumes it.
        case .eventAdded:
            wait.continuation.resume()
        case .cancelled:
            wait.continuation.resume(throwing: CancellationError())
        }
    }

    /// Ends a wait whose task was cancelled with `CancellationError`, when it
    /// is still waiting.
    ///
    /// - Parameter waitId: Id of the wait.
    private func cancelEventWait(_ waitId: Int) {
        let wait = entries.withLock { $0.removeWait(waitId) }
        wait?.continuation.resume(throwing: CancellationError())
    }
}

/// A wait for an event of a ``ReaderVmEventLog``.
private struct EventWait: Sendable {
    /// Id that tells the wait from every other wait of its log.
    let id: Int
    /// The event waited for.
    let event: ReaderVmEvent
    /// How many times the log must have the event; at least 1.
    let count: Int
    /// The suspended waiter.
    let continuation: CheckedContinuation<Void, any Error>
}

/// How a wait given to a ``ReaderVmEventLog`` starts.
private enum EventWaitStart {
    /// It waits for its event.
    case waiting
    /// The log has its events, so it ends now.
    case eventAdded
    /// Its task was cancelled, so it ends now with `CancellationError`.
    case cancelled
}

/// Owns the events of a ``ReaderVmEventLog`` and the waits for them, to give
/// the log one value to guard, while guaranteeing that `waits` holds exactly
/// the waits whose events aren't all in `events` and whose task wasn't
/// cancelled.
///
/// Concurrency model: single-owner. Only its log's mutex reaches it.
private struct ReaderVmEventEntries {
    /// The events, oldest first.
    private(set) var events: [ReaderVmEvent] = []
    /// The waiting waits, keyed by id.
    private var waits: [Int: EventWait] = [:]
    /// Id the next wait gets.
    private var nextWaitId = 0

    /// Creates an id that no other wait of the log has.
    ///
    /// - Returns: The id.
    mutating func createWaitId() -> Int {
        defer { nextWaitId += 1 }
        return nextWaitId
    }

    /// Adds an event and removes the waits that the log now has every event
    /// for.
    ///
    /// - Parameter event: What happened.
    /// - Returns: The removed waits, for the log to resume.
    mutating func addEvent(_ event: ReaderVmEvent) -> [EventWait] {
        events.append(event)
        let endedWaits = waits.values.filter { hasEvents(for: $0) }
        waits = waits.filter { !hasEvents(for: $0.value) }
        return endedWaits
    }

    /// Adds a wait to the waiting ones, unless it must end at once.
    ///
    /// - Parameters:
    ///   - wait: The wait that is starting.
    ///   - isTaskCancelled: Whether the wait's task is cancelled.
    /// - Returns: How the wait starts; only a waiting one was added.
    mutating func addWait(_ wait: EventWait, isTaskCancelled: Bool) -> EventWaitStart {
        guard !isTaskCancelled else {
            return .cancelled
        }
        guard !hasEvents(for: wait) else {
            return .eventAdded
        }
        waits[wait.id] = wait
        return .waiting
    }

    /// Removes a waiting wait.
    ///
    /// - Parameter waitId: Id of the wait.
    /// - Returns: The wait, or `nil` when it isn't waiting, because it has
    ///   ended or never waited.
    mutating func removeWait(_ waitId: Int) -> EventWait? {
        waits.removeValue(forKey: waitId)
    }

    /// Answers whether the log has a wait's event as many times as the wait
    /// needs.
    ///
    /// - Parameter wait: The wait.
    /// - Returns: Whether the wait can end.
    private func hasEvents(for wait: EventWait) -> Bool {
        events.count { $0 == wait.event } >= wait.count
    }
}
