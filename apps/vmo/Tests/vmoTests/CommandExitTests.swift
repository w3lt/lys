import Foundation
import Testing
@testable import vmo

/// What the waited command wrote and its exit code: output on both streams
/// and a failing exit code, which is part of the exit, not a failure.
private let commandOutput = CommandOutput(
    stdout: CommandStreamOutput(bytes: Data("<p>Hi</p>\n".utf8), isTruncated: false),
    stderr: CommandStreamOutput(bytes: Data("Error: page not read\n".utf8), isTruncated: false),
    exitCode: 1
)

/// Container id under which the event log records the end of each wait. No
/// VM exists; the log only needs a name for the waited command.
private let waitedVmId = ContainerId(text: "vm-1")

/// Why waiting for the command failed, in the exit of the case that resolves
/// the exit with a failure.
private struct CommandWaitFailure: Error, Equatable {}

/// Starts waiting for `commandExit` in a task of its own, which adds
/// ``ReaderVmEvent/waitEnded(containerId:)`` to `eventLog` once the wait
/// returns or throws, so the case can wait for it within its time limit.
///
/// - Parameters:
///   - commandExit: The exit to wait for.
///   - eventLog: Where the end of the wait is recorded.
/// - Returns: The wait's task.
private func startExitWait(
    for commandExit: CommandExit,
    recordingInto eventLog: ReaderVmEventLog
) -> Task<Result<CommandOutput, any Error>, any Error> {
    Task {
        defer { eventLog.addEvent(.waitEnded(containerId: waitedVmId)) }
        return try await commandExit.waitForExit()
    }
}

/// Starts waiting as ``startExitWait(for:recordingInto:)`` does, from a task
/// that is cancelled before the wait begins.
///
/// - Parameters:
///   - commandExit: The exit to wait for.
///   - eventLog: Where the end of the wait is recorded.
/// - Returns: The task, which throws what the wait throws.
private func startCancelledExitWait(
    for commandExit: CommandExit,
    recordingInto eventLog: ReaderVmEventLog
) -> Task<Result<CommandOutput, any Error>, any Error> {
    Task {
        defer { eventLog.addEvent(.waitEnded(containerId: waitedVmId)) }
        // A task added to a cancelled group starts cancelled.
        return try await withThrowingTaskGroup(of: Result<CommandOutput, any Error>.self) { group in
            group.cancelAll()
            group.addTask { try await commandExit.waitForExit() }
            return try #require(try await group.next())
        }
    }
}

/// Checks that ``CommandExit`` gives every wait the one exit it is resolved
/// with, and that cancelling a caller ends only that caller's wait.
///
/// Each case waits for the ends of its waits through a ``ReaderVmEventLog``,
/// which the time limit can cancel, before it awaits their tasks, whose
/// results it can't.
@Suite("Command exit", .timeLimit(.minutes(1)))
struct CommandExitTests {
    /// Verifies that waits running while the exit is resolved and a wait
    /// begun after it all get the same exit.
    @Test("Every wait gets the exit, whether it ran while the exit was resolved or began after")
    func returnsExitToEveryWait() async throws {
        let commandExit = CommandExit()
        let eventLog = ReaderVmEventLog()
        let firstWait = startExitWait(for: commandExit, recordingInto: eventLog)
        let secondWait = startExitWait(for: commandExit, recordingInto: eventLog)

        commandExit.resolve(with: .success(commandOutput))
        try await eventLog.waitForEvent(.waitEnded(containerId: waitedVmId), count: 2)
        let laterExit = try await commandExit.waitForExit()

        expectOutput(try await firstWait.value.get(), toEqual: commandOutput)
        expectOutput(try await secondWait.value.get(), toEqual: commandOutput)
        expectOutput(try laterExit.get(), toEqual: commandOutput)
    }

    /// Verifies that a failed wait for the command reaches the waits as the
    /// exit they return, so that only a caller's cancellation is thrown.
    @Test("An exit resolved with a failure is returned to the wait, not thrown")
    func returnsFailedExit() async throws {
        let commandExit = CommandExit()

        commandExit.resolve(with: .failure(CommandWaitFailure()))
        let exit = try await commandExit.waitForExit()

        #expect(throws: CommandWaitFailure()) { try exit.get() }
    }

    /// Verifies that cancelling one caller ends its wait at once, before the
    /// exit is resolved, and that the other wait still gets the exit.
    ///
    /// The cancellation can reach the wait before or after it is kept, and
    /// both must end it the same way; ``throwsCancellationForCancelledWait()``
    /// checks a caller cancelled before its wait began.
    @Test("Cancelling one wait ends only that wait, with CancellationError, and the other wait gets the exit")
    func endsOnlyCancelledWait() async throws {
        let commandExit = CommandExit()
        let eventLog = ReaderVmEventLog()
        let wait = startExitWait(for: commandExit, recordingInto: eventLog)
        let cancelledWait = startExitWait(for: commandExit, recordingInto: eventLog)

        cancelledWait.cancel()
        try await eventLog.waitForEvent(.waitEnded(containerId: waitedVmId))
        commandExit.resolve(with: .success(commandOutput))
        try await eventLog.waitForEvent(.waitEnded(containerId: waitedVmId), count: 2)

        await #expect(throws: CancellationError.self) { try await cancelledWait.value }
        expectOutput(try await wait.value.get(), toEqual: commandOutput)
    }

    /// Verifies that a caller cancelled before it waits gets
    /// `CancellationError` at once, both while the exit is pending and once it
    /// is resolved.
    @Test("A wait whose caller is already cancelled throws CancellationError, before and after the exit is resolved")
    func throwsCancellationForCancelledWait() async throws {
        let commandExit = CommandExit()
        let eventLog = ReaderVmEventLog()

        let pendingWait = startCancelledExitWait(for: commandExit, recordingInto: eventLog)
        try await eventLog.waitForEvent(.waitEnded(containerId: waitedVmId))
        commandExit.resolve(with: .success(commandOutput))
        let resolvedWait = startCancelledExitWait(for: commandExit, recordingInto: eventLog)
        try await eventLog.waitForEvent(.waitEnded(containerId: waitedVmId), count: 2)

        await #expect(throws: CancellationError.self) { try await pendingWait.value }
        await #expect(throws: CancellationError.self) { try await resolvedWait.value }
    }
}
