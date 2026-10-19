import Synchronization

/// Owns a time that moves only when a test moves it, to let tests decide
/// exactly when a deadline passes, while guaranteeing that every sleep on it
/// ends once its deadline has come or its task is cancelled.
///
/// Its instants count from the clock's creation, so they mean nothing to
/// another clock.
///
/// Concurrency model: concurrent. Any task can read the time, sleep, or move
/// the time; one mutex guards the time and the sleeps, and sleeps are resumed
/// after it is released.
final class ManualClock: Clock {
    /// A point in time on a manual clock.
    struct Instant: InstantProtocol {
        /// How long after the clock's creation this instant is.
        let offset: Swift.Duration

        /// Returns the instant `duration` after this one.
        ///
        /// - Parameter duration: How far to move; a negative one moves back.
        /// - Returns: The moved instant.
        func advanced(by duration: Swift.Duration) -> Instant {
            Instant(offset: offset + duration)
        }

        /// Calculates how long it is from this instant to `other`.
        ///
        /// - Parameter other: Another instant of the same clock.
        /// - Returns: The duration, negative when `other` is earlier.
        func duration(to other: Instant) -> Swift.Duration {
            other.offset - offset
        }

        /// Answers whether `lhs` comes before `rhs`.
        ///
        /// - Parameters:
        ///   - lhs: An instant.
        ///   - rhs: An instant of the same clock.
        /// - Returns: Whether `lhs` is earlier.
        static func < (lhs: Instant, rhs: Instant) -> Bool {
            lhs.offset < rhs.offset
        }
    }

    /// The time and the sleeps waiting for it.
    private let timeline = Mutex(ManualTimeline())

    /// Creates a clock at its start, with no sleeps.
    init() {}

    /// The current time. It starts at the clock's creation and moves only
    /// through ``updateNow(to:)``.
    var now: Instant {
        timeline.withLock { $0.now }
    }

    /// Zero: the time is exactly where a test moved it.
    var minimumResolution: Swift.Duration {
        .zero
    }

    /// How many sleeps are waiting for their deadline. A test reads it to see
    /// that a timer it no longer needs was released.
    var pendingSleepCount: Int {
        timeline.withLock { $0.pendingSleepCount }
    }

    /// Suspends until ``updateNow(to:)`` moves the time to `deadline` or past
    /// it.
    ///
    /// - Parameters:
    ///   - deadline: When the sleep ends. One that has come ends it at once.
    ///   - tolerance: Unused: the time moves only to where a test moves it.
    /// - Throws: `CancellationError` when the task is cancelled before the
    ///   deadline comes, including before the sleep began.
    func sleep(until deadline: Instant, tolerance _: Swift.Duration?) async throws {
        let sleepId = timeline.withLock { $0.createSleepId() }
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                addSleep(PendingSleep(id: sleepId, deadline: deadline, continuation: continuation))
            }
        } onCancel: {
            cancelSleep(sleepId)
        }
    }

    /// Moves the time forward to `instant`, ending every sleep whose deadline
    /// has then come.
    ///
    /// - Parameter instant: The new time.
    /// - Precondition: `instant` isn't before ``now``: time on this clock
    ///   never goes back.
    func updateNow(to instant: Instant) {
        let endedSleeps = timeline.withLock { $0.updateNow(to: instant) }
        endedSleeps.forEach { $0.continuation.resume() }
    }

    /// Keeps a sleep until its deadline, or ends it at once when the deadline
    /// has come or its task is cancelled.
    ///
    /// The cancellation check and the keeping share the mutex with
    /// ``cancelSleep(_:)``, so a cancellation is never missed: it either
    /// comes before, and is seen here, or after, and finds the sleep kept.
    ///
    /// - Parameter sleep: The sleep that is starting.
    private func addSleep(_ sleep: PendingSleep) {
        let start = timeline.withLock { $0.addSleep(sleep, isTaskCancelled: Task.isCancelled) }
        switch start {
        case .waiting:
            return // updateNow(to:) or cancelSleep(_:) resumes it.
        case .deadlineCome:
            sleep.continuation.resume()
        case .cancelled:
            sleep.continuation.resume(throwing: CancellationError())
        }
    }

    /// Ends a sleep whose task was cancelled with `CancellationError`, when
    /// it is still waiting.
    ///
    /// - Parameter sleepId: Id of the sleep.
    private func cancelSleep(_ sleepId: Int) {
        let sleep = timeline.withLock { $0.removeSleep(sleepId) }
        sleep?.continuation.resume(throwing: CancellationError())
    }
}

/// A sleep on a ``ManualClock``.
private struct PendingSleep: Sendable {
    /// Id that tells the sleep from every other sleep of its clock.
    let id: Int
    /// When the sleep ends.
    let deadline: ManualClock.Instant
    /// The suspended sleeper.
    let continuation: CheckedContinuation<Void, any Error>
}

/// How a sleep given to a ``ManualClock`` starts.
private enum SleepStart {
    /// It waits for its deadline.
    case waiting
    /// Its deadline has come, so it ends now.
    case deadlineCome
    /// Its task was cancelled, so it ends now with `CancellationError`.
    case cancelled
}

/// Owns the time of a ``ManualClock`` and the sleeps waiting for it, to give
/// the clock one value to guard, while guaranteeing that `sleeps` holds
/// exactly the sleeps whose deadline is after `now` and whose task wasn't
/// cancelled.
///
/// Concurrency model: single-owner. Only its clock's mutex reaches it.
private struct ManualTimeline {
    /// The current time. It never goes back.
    private(set) var now = ManualClock.Instant(offset: .zero)
    /// The waiting sleeps, keyed by id.
    private var sleeps: [Int: PendingSleep] = [:]
    /// Id the next sleep gets.
    private var nextSleepId = 0

    /// How many sleeps are waiting.
    var pendingSleepCount: Int {
        sleeps.count
    }

    /// Creates an id that no other sleep of the clock has.
    ///
    /// - Returns: The id.
    mutating func createSleepId() -> Int {
        defer { nextSleepId += 1 }
        return nextSleepId
    }

    /// Adds a sleep to the waiting ones, unless it must end at once.
    ///
    /// - Parameters:
    ///   - sleep: The sleep that is starting.
    ///   - isTaskCancelled: Whether the sleep's task is cancelled.
    /// - Returns: How the sleep starts; only a waiting one was added.
    mutating func addSleep(_ sleep: PendingSleep, isTaskCancelled: Bool) -> SleepStart {
        guard !isTaskCancelled else {
            return .cancelled
        }
        guard sleep.deadline > now else {
            return .deadlineCome
        }
        sleeps[sleep.id] = sleep
        return .waiting
    }

    /// Removes a waiting sleep.
    ///
    /// - Parameter sleepId: Id of the sleep.
    /// - Returns: The sleep, or `nil` when it isn't waiting, because it has
    ///   ended or never waited.
    mutating func removeSleep(_ sleepId: Int) -> PendingSleep? {
        sleeps.removeValue(forKey: sleepId)
    }

    /// Moves the time forward and removes the sleeps whose deadline has come.
    ///
    /// - Parameter instant: The new time.
    /// - Returns: The removed sleeps, for the clock to resume.
    /// - Precondition: `instant` isn't before ``now``.
    mutating func updateNow(to instant: ManualClock.Instant) -> [PendingSleep] {
        precondition(now <= instant, "Time on a manual clock never goes back")
        now = instant
        let endedSleeps = sleeps.values.filter { $0.deadline <= instant }
        sleeps = sleeps.filter { $0.value.deadline > instant }
        return endedSleeps
    }
}
