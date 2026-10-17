import Foundation
import Synchronization
import Testing
@testable import vmo

/// How many times ``countSignal(_:)`` has run.
private let handledSignalCount = Atomic<Int>(0)

/// Signal handler that counts its calls. It only updates an atomic, which is
/// safe inside a signal handler.
///
/// - Parameter signalNumber: The signal received; not used.
private func countSignal(_ signalNumber: Int32) {
    handledSignalCount.add(1, ordering: .relaxed)
}

/// Which child task of the delivery test ended first.
private enum SignalTestEvent: Equatable, Sendable {
    /// The wait returned.
    case signalObserved
    /// The sender stopped; it only stops when cancelled.
    case senderStopped
}

/// Checks how the process waits for a signal. The tests change process-wide
/// signal actions, so they run one at a time, on `SIGUSR1` and `SIGUSR2`,
/// which nothing else in the test process uses.
@Suite("Waiting for a signal", .serialized)
struct SignalTests {
    /// Verifies that a signal from the list ends the wait.
    @Test("Returns when one of the signals arrives", .timeLimit(.minutes(1)))
    func returnsOnSignal() async {
        let previousAction = signal(SIGUSR1, SIG_IGN)
        defer { signal(SIGUSR1, previousAction) }

        let firstEvent = await withTaskGroup(of: SignalTestEvent.self) { group in
            group.addTask {
                await waitForSignal(in: [SIGUSR1])
                return .signalObserved
            }
            group.addTask {
                await sendSignalUntilCancelled(SIGUSR1)
                return .senderStopped
            }
            let firstEvent = await group.next()
            group.cancelAll()
            return firstEvent
        }

        #expect(firstEvent == .signalObserved)
    }

    /// Verifies that cancelling the caller ends the wait without a signal.
    @Test("Returns when the calling task is cancelled", .timeLimit(.minutes(1)))
    func returnsOnCancellation() async {
        let waiter = Task { await waitForSignal(in: [SIGUSR2]) }

        waiter.cancel()

        await waiter.value
    }

    /// Verifies that the signal's earlier action runs again after the wait.
    @Test("Puts the previous signal action back when it returns", .timeLimit(.minutes(1)))
    func restoresPreviousAction() async {
        let originalAction = signal(SIGUSR2, countSignal)
        defer { signal(SIGUSR2, originalAction) }
        let waiter = Task { await waitForSignal(in: [SIGUSR2]) }
        waiter.cancel()
        await waiter.value
        let countBeforeSignal = handledSignalCount.load(ordering: .relaxed)

        kill(getpid(), SIGUSR2)
        // Concurrency threads block signals, so the handler runs on another
        // thread, possibly after `kill` returns.
        while handledSignalCount.load(ordering: .relaxed) == countBeforeSignal, !Task.isCancelled {
            await Task.yield()
        }

        #expect(handledSignalCount.load(ordering: .relaxed) == countBeforeSignal + 1)
    }
}

/// Sends `signalNumber` to this process again and again until the calling
/// task is cancelled.
///
/// The waiter can't report when it starts listening, so the signal repeats
/// until it is observed. The caller makes the signal ignored first, so a
/// signal sent before the waiter listens has no effect.
///
/// - Parameter signalNumber: Signal to send.
private func sendSignalUntilCancelled(_ signalNumber: Int32) async {
    while !Task.isCancelled {
        kill(getpid(), signalNumber)
        await Task.yield()
    }
}
