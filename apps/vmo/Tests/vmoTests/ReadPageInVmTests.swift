import Foundation
import Testing
@testable import vmo

/// Text of the page URL that every read here asks for. Foundation would
/// encode its `%20` again because of the brackets, so a reader argument with
/// exactly this text shows that the URL reached the reader unchanged.
private let pageUrlText = "https://example.com/search?q=hello%20world&filter[type]=article"

/// Container id of each read's VM: the first VM its lifecycle creates.
private let readerVmId = ContainerId(text: "vm-1")

/// What the reader writes when it reads the page: the page's HTML, and exit
/// code 0.
private let readerOutput = CommandOutput(
    stdout: CommandStreamOutput(bytes: Data("<p>Hi</p>\n".utf8), isTruncated: false),
    stderr: CommandStreamOutput(bytes: Data(), isTruncated: false),
    exitCode: 0
)

/// The creation of each read's VM, as the read must ask for it: the reader
/// image, with the page URL's text as its only argument.
private let readerVmCreation = ReaderVmEvent.createVm(imageReference: readPageImageReference, arguments: [pageUrlText])

extension ReadPageOutcome {
    /// The reader's output when the reader exited before the deadline, or
    /// `nil` when the read timed out.
    fileprivate var readerExitOutput: CommandOutput? {
        switch self {
        case .readerExited(let output): output
        case .timedOut: nil
        }
    }

    /// Whether the deadline passed before the reader exited.
    fileprivate var isTimedOut: Bool {
        switch self {
        case .readerExited: false
        case .timedOut: true
        }
    }
}

/// Owns one test's clock and event log, to read the page through an
/// ``InMemoryReaderVmLifecycle`` with a deadline that only the test moves,
/// while guaranteeing that waiting for the read ends when the test's time
/// limit cancels it.
///
/// It gives the test the page's parsed URL, a deadline on ``clock``, and
/// lifecycles that record into ``eventLog``. The test moves ``clock`` and
/// controls each lifecycle's VMs; ``eventLog`` records what each lifecycle
/// and the read did. It owns no resource: a read that never ends is left
/// running when its test fails, and holds only memory.
///
/// Concurrency model: single-owner. One test creates and uses it; the read it
/// starts shares only ``clock`` and ``eventLog``, which are concurrent.
private struct ReadPageInVmHarness {
    /// The page every read asks for.
    let url: PageUrl
    /// The clock the reads' deadlines are on. Only the test moves it.
    let clock: ManualClock
    /// What the lifecycles were asked to do, what their VMs did, and when the
    /// read ended.
    let eventLog = ReaderVmEventLog()
    /// Thirty seconds after the clock's start: a deadline that passes only
    /// when the test moves the clock to it.
    let deadline: ReadDeadline<ManualClock>

    /// Creates a harness at its clock's start, with no events.
    ///
    /// - Throws: `ExpectationFailedError`, after recording an issue, when the
    ///   page's URL doesn't parse.
    init() throws {
        url = try #require(parsePageUrl(pageUrlText))
        let clock = ManualClock()
        self.clock = clock
        deadline = ReadDeadline(instant: clock.now.advanced(by: .seconds(30)), clock: clock)
    }

    /// Creates a lifecycle that records into ``eventLog``.
    ///
    /// - Parameter script: How the lifecycle's VMs behave.
    /// - Returns: The lifecycle, with no VMs.
    func createLifecycle(_ script: ReaderVmScript) -> InMemoryReaderVmLifecycle {
        InMemoryReaderVmLifecycle(script: script, events: eventLog)
    }

    /// Starts reading the page through `lifecycle` in a task of its own,
    /// which adds ``ReaderVmEvent/readEnded`` to ``eventLog`` once the read
    /// returns or throws. A test starts one read.
    ///
    /// - Parameters:
    ///   - lifecycle: Lifecycle the read runs its VM in.
    ///   - deadline: When the read must end, on ``clock``.
    /// - Returns: The read's task.
    func startRead(
        through lifecycle: InMemoryReaderVmLifecycle,
        until deadline: ReadDeadline<ManualClock>
    ) -> Task<ReadPageOutcome, any Error> {
        Task { [url, eventLog] in
            defer { eventLog.addEvent(.readEnded) }
            return try await readPageInVm(url, lifecycle, deadline: deadline)
        }
    }

    /// Waits until the read that ``startRead(through:until:)`` started has
    /// ended.
    ///
    /// It waits for ``ReaderVmEvent/readEnded``, which the test's time limit
    /// can cancel, before it awaits the read's task, whose result it can't.
    ///
    /// - Parameter read: The read's task.
    /// - Returns: How the read ended.
    /// - Throws: `CancellationError` when the test's time limit cancels the
    ///   test before the read ends.
    func waitForReadEnd(_ read: Task<ReadPageOutcome, any Error>) async throws -> Result<ReadPageOutcome, any Error> {
        try await eventLog.waitForEvent(.readEnded)
        return await read.result
    }

    /// Checks that the read's VM is no longer available, because deleting it
    /// again fails as unknown. It records another deletion in ``eventLog``.
    ///
    /// - Parameters:
    ///   - lifecycle: Lifecycle the read ran its VM in.
    ///   - sourceLocation: Where a failed check is reported; the caller's
    ///     line by default.
    func expectReaderVmDeleted(
        in lifecycle: InMemoryReaderVmLifecycle,
        sourceLocation: SourceLocation = #_sourceLocation
    ) async {
        await #expect(throws: ReaderVmLifecycleError.unknownVm(containerId: readerVmId), sourceLocation: sourceLocation) {
            try await lifecycle.deleteVm(containerId: readerVmId)
        }
    }

    /// Checks the events of a read that began deleting its VM as soon as the
    /// start ended, and whose reader, whose stop failed, then exited: the
    /// wait for the reader and the deletion, in either order, then the
    /// reader's exit, and only then the end of the wait and of the read.
    ///
    /// - Parameter sourceLocation: Where a failed check is reported; the
    ///   caller's line by default.
    func expectReadEndedAfterUnstoppedReader(sourceLocation: SourceLocation = #_sourceLocation) {
        let events = eventLog.events
        let readerStart: [ReaderVmEvent] = [
            readerVmCreation,
            .startVm(containerId: readerVmId),
            .startEnded(containerId: readerVmId),
        ]
        let waitAndDeletion: [ReaderVmEvent] = [
            .waitForCommandExit(containerId: readerVmId),
            .deleteVm(containerId: readerVmId, isCallerCancelled: false),
        ]
        let readerEnd: [ReaderVmEvent] = [
            .commandExited(containerId: readerVmId),
            .waitEnded(containerId: readerVmId),
            .readEnded,
        ]
        #expect(Array(events.prefix(3)) == readerStart, sourceLocation: sourceLocation)
        let middle = Array(events.dropFirst(3).dropLast(3))
        #expect(middle == waitAndDeletion || middle == waitAndDeletion.reversed(), sourceLocation: sourceLocation)
        #expect(Array(events.suffix(3)) == readerEnd, sourceLocation: sourceLocation)
    }
}

/// Checks how ``readPageInVm(_:_:deadline:)`` ends when no step of its VM
/// fails: with the reader's output, or timed out, and with its VM deleted
/// either way.
///
/// The reads run against an ``InMemoryReaderVmLifecycle``, which keeps the
/// contract of ``ReaderVmLifecycle`` as the lifecycle contract suites check,
/// and on a ``ManualClock``. In a test, a read in a real VM needs a Linux
/// kernel, which vmo finds only on one developer's Mac until #200, and a
/// process signed with the virtualization entitlement, which `swift test`
/// doesn't give.
@Suite("Reading a page in a VM", .timeLimit(.minutes(1)))
struct ReadPageInVmOutcomeTests {
    /// This test's clock, event log, and page.
    private let harness: ReadPageInVmHarness

    /// Creates this test's harness.
    ///
    /// - Throws: `ExpectationFailedError` when the page's URL doesn't parse.
    init() throws {
        harness = try ReadPageInVmHarness()
    }

    /// Verifies the whole read when the reader exits first, and that its VM
    /// and its timer are gone when it returns.
    @Test("A reader that exits before the deadline gives its output, after its VM is deleted")
    func returnsReaderOutput() async throws {
        let lifecycle = harness.createLifecycle(ReaderVmScript(command: .exitsAtStart(readerOutput)))

        let read = harness.startRead(through: lifecycle, until: harness.deadline)
        let result = try await harness.waitForReadEnd(read)

        let output = try #require(try result.get().readerExitOutput)
        #expect(output.stdout == readerOutput.stdout)
        #expect(output.stderr == readerOutput.stderr)
        #expect(output.exitCode == readerOutput.exitCode)
        #expect(
            harness.eventLog.events == [
                readerVmCreation,
                .startVm(containerId: readerVmId),
                .startEnded(containerId: readerVmId),
                .waitForCommandExit(containerId: readerVmId),
                .waitEnded(containerId: readerVmId),
                .deleteVm(containerId: readerVmId, isCallerCancelled: false),
                .readEnded,
            ]
        )
        #expect(harness.clock.pendingSleepCount == 0)
        await harness.expectReaderVmDeleted(in: lifecycle)
    }

    /// Verifies the deadline check between creating and starting the VM. At
    /// the deadline itself no time is left, so the VM is deleted unstarted;
    /// a reader that started would have exited with its output.
    @Test("A deadline that has come when the VM is created times the read out without starting the VM")
    func timesOutAfterCreation() async throws {
        let lifecycle = harness.createLifecycle(ReaderVmScript(command: .exitsAtStart(readerOutput)))
        let comeDeadline = ReadDeadline(instant: harness.clock.now, clock: harness.clock)

        let read = harness.startRead(through: lifecycle, until: comeDeadline)
        let result = try await harness.waitForReadEnd(read)

        #expect(try result.get().isTimedOut)
        #expect(
            harness.eventLog.events == [
                readerVmCreation,
                .deleteVm(containerId: readerVmId, isCallerCancelled: false),
                .readEnded,
            ]
        )
        await harness.expectReaderVmDeleted(in: lifecycle)
    }

    /// Verifies that the deadline cuts the reader's run short: deleting the
    /// VM is what ends the wait for the reader.
    @Test("A deadline that passes while the reader runs deletes the VM, which ends the reader, and times the read out")
    func timesOutWhileReaderRuns() async throws {
        let lifecycle = harness.createLifecycle(ReaderVmScript(command: .runsUntilResolved))
        let read = harness.startRead(through: lifecycle, until: harness.deadline)
        try await harness.eventLog.waitForEvent(.waitForCommandExit(containerId: readerVmId))

        harness.clock.updateNow(to: harness.deadline.instant)
        let result = try await harness.waitForReadEnd(read)

        #expect(try result.get().isTimedOut)
        #expect(
            harness.eventLog.events == [
                readerVmCreation,
                .startVm(containerId: readerVmId),
                .startEnded(containerId: readerVmId),
                .waitForCommandExit(containerId: readerVmId),
                .deleteVm(containerId: readerVmId, isCallerCancelled: false),
                .waitEnded(containerId: readerVmId),
                .readEnded,
            ]
        )
        await harness.expectReaderVmDeleted(in: lifecycle)
    }

    /// Verifies that a start isn't interrupted when the deadline passes, and
    /// that the read times out as soon as the start ends. Once the start
    /// ends, the wait for the reader and the deletion run concurrently, so
    /// their order isn't checked.
    @Test("A deadline that passes while the VM starts times the read out once the start ends")
    func timesOutAfterStart() async throws {
        let lifecycle = harness.createLifecycle(ReaderVmScript(command: .runsUntilResolved, holdsStart: true))
        let read = harness.startRead(through: lifecycle, until: harness.deadline)
        try await harness.eventLog.waitForEvent(.startVm(containerId: readerVmId))

        harness.clock.updateNow(to: harness.deadline.instant)
        await lifecycle.resolveStart(containerId: readerVmId)
        let result = try await harness.waitForReadEnd(read)

        #expect(try result.get().isTimedOut)
        let events = harness.eventLog.events
        #expect(
            Array(events.prefix(3)) == [
                readerVmCreation,
                .startVm(containerId: readerVmId),
                .startEnded(containerId: readerVmId),
            ]
        )
        #expect(events.contains(.deleteVm(containerId: readerVmId, isCallerCancelled: false)))
        #expect(events.last == .readEnded)
        await harness.expectReaderVmDeleted(in: lifecycle)
    }
}

/// Checks how ``readPageInVm(_:_:deadline:)`` fails when a step of its VM
/// fails: with that step's failure, or with a ``CleanupAfterFailureError``
/// when deleting the VM fails after another failure.
///
/// The reads run as in ``ReadPageInVmOutcomeTests``; each case makes the
/// lifecycle fail the steps it names.
@Suite("Reading a page in a VM when a VM step fails", .timeLimit(.minutes(1)))
struct ReadPageInVmFailureTests {
    /// This test's clock, event log, and page.
    private let harness: ReadPageInVmHarness

    /// Creates this test's harness.
    ///
    /// - Throws: `ExpectationFailedError` when the page's URL doesn't parse.
    init() throws {
        harness = try ReadPageInVmHarness()
    }

    /// Verifies that a creation failure reaches the caller and that the read
    /// starts and deletes nothing: the lifecycle deletes what a failed
    /// creation left.
    @Test("A failed creation fails the read without a start or a deletion")
    func throwsCreationFailure() async throws {
        let lifecycle = harness.createLifecycle(
            ReaderVmScript(command: .exitsAtStart(readerOutput), failingSteps: [.creation])
        )

        let read = harness.startRead(through: lifecycle, until: harness.deadline)
        let result = try await harness.waitForReadEnd(read)

        #expect(throws: ReaderVmStepFailure(step: .creation)) { try result.get() }
        #expect(harness.eventLog.events == [readerVmCreation, .readEnded])
    }

    /// Verifies that a start failure reaches the caller once the VM is
    /// deleted.
    @Test("A failed start fails the read after its VM is deleted")
    func throwsStartFailure() async throws {
        let lifecycle = harness.createLifecycle(
            ReaderVmScript(command: .exitsAtStart(readerOutput), failingSteps: [.start])
        )

        let read = harness.startRead(through: lifecycle, until: harness.deadline)
        let result = try await harness.waitForReadEnd(read)

        #expect(throws: ReaderVmStepFailure(step: .start)) { try result.get() }
        #expect(
            harness.eventLog.events == [
                readerVmCreation,
                .startVm(containerId: readerVmId),
                .startEnded(containerId: readerVmId),
                .deleteVm(containerId: readerVmId, isCallerCancelled: false),
                .readEnded,
            ]
        )
        await harness.expectReaderVmDeleted(in: lifecycle)
    }

    /// Verifies that neither failure hides the other when the VM of a failed
    /// start can't be deleted.
    @Test("A failed start whose VM can't be deleted fails the read with both failures")
    func throwsStartAndDeletionFailures() async throws {
        let lifecycle = harness.createLifecycle(
            ReaderVmScript(command: .exitsAtStart(readerOutput), failingSteps: [.start, .deletion])
        )

        let read = harness.startRead(through: lifecycle, until: harness.deadline)
        let result = try await harness.waitForReadEnd(read)

        let error = try #require(throws: CleanupAfterFailureError.self) { try result.get() }
        #expect(error.operationError as? ReaderVmStepFailure == ReaderVmStepFailure(step: .start))
        #expect(error.cleanupError as? ReaderVmStepFailure == ReaderVmStepFailure(step: .deletion))
        #expect(
            harness.eventLog.events == [
                readerVmCreation,
                .startVm(containerId: readerVmId),
                .startEnded(containerId: readerVmId),
                .deleteVm(containerId: readerVmId, isCallerCancelled: false),
                .readEnded,
            ]
        )
    }

    /// Verifies that a failed wait for the reader reaches the caller once the
    /// VM is deleted, and that the read's timer is gone.
    @Test("A failed wait for the reader fails the read after its VM is deleted")
    func throwsWaitFailure() async throws {
        let lifecycle = harness.createLifecycle(ReaderVmScript(command: .runsUntilResolved, failingSteps: [.wait]))

        let read = harness.startRead(through: lifecycle, until: harness.deadline)
        let result = try await harness.waitForReadEnd(read)

        #expect(throws: ReaderVmStepFailure(step: .wait)) { try result.get() }
        #expect(
            harness.eventLog.events == [
                readerVmCreation,
                .startVm(containerId: readerVmId),
                .startEnded(containerId: readerVmId),
                .waitForCommandExit(containerId: readerVmId),
                .waitEnded(containerId: readerVmId),
                .deleteVm(containerId: readerVmId, isCallerCancelled: false),
                .readEnded,
            ]
        )
        #expect(harness.clock.pendingSleepCount == 0)
        await harness.expectReaderVmDeleted(in: lifecycle)
    }

    /// Verifies that neither failure hides the other when the VM of a failed
    /// wait can't be deleted.
    @Test("A failed wait whose VM can't be deleted fails the read with both failures")
    func throwsWaitAndDeletionFailures() async throws {
        let lifecycle = harness.createLifecycle(
            ReaderVmScript(command: .runsUntilResolved, failingSteps: [.wait, .deletion])
        )

        let read = harness.startRead(through: lifecycle, until: harness.deadline)
        let result = try await harness.waitForReadEnd(read)

        let error = try #require(throws: CleanupAfterFailureError.self) { try result.get() }
        #expect(error.operationError as? ReaderVmStepFailure == ReaderVmStepFailure(step: .wait))
        #expect(error.cleanupError as? ReaderVmStepFailure == ReaderVmStepFailure(step: .deletion))
        #expect(
            harness.eventLog.events == [
                readerVmCreation,
                .startVm(containerId: readerVmId),
                .startEnded(containerId: readerVmId),
                .waitForCommandExit(containerId: readerVmId),
                .waitEnded(containerId: readerVmId),
                .deleteVm(containerId: readerVmId, isCallerCancelled: false),
                .readEnded,
            ]
        )
    }

    /// Verifies that a VM left behind fails the read even when the reader
    /// gave its output: the caller learns that a VM may still hold memory.
    @Test("A reader's output isn't returned when its VM can't be deleted: the read throws the deletion failure")
    func throwsDeletionFailureAfterReaderExits() async throws {
        let lifecycle = harness.createLifecycle(
            ReaderVmScript(command: .exitsAtStart(readerOutput), failingSteps: [.deletion])
        )

        let read = harness.startRead(through: lifecycle, until: harness.deadline)
        let result = try await harness.waitForReadEnd(read)

        #expect(throws: ReaderVmStepFailure(step: .deletion)) { try result.get() }
        #expect(
            harness.eventLog.events == [
                readerVmCreation,
                .startVm(containerId: readerVmId),
                .startEnded(containerId: readerVmId),
                .waitForCommandExit(containerId: readerVmId),
                .waitEnded(containerId: readerVmId),
                .deleteVm(containerId: readerVmId, isCallerCancelled: false),
                .readEnded,
            ]
        )
    }

    /// Verifies that a timeout before the start doesn't hide a VM that can't
    /// be deleted.
    @Test("A read whose deadline has come when the VM is created throws the deletion failure when the VM can't be deleted")
    func throwsDeletionFailureAfterCreationTimeout() async throws {
        let lifecycle = harness.createLifecycle(
            ReaderVmScript(command: .exitsAtStart(readerOutput), failingSteps: [.deletion])
        )
        let comeDeadline = ReadDeadline(instant: harness.clock.now, clock: harness.clock)

        let read = harness.startRead(through: lifecycle, until: comeDeadline)
        let result = try await harness.waitForReadEnd(read)

        #expect(throws: ReaderVmStepFailure(step: .deletion)) { try result.get() }
        #expect(
            harness.eventLog.events == [
                readerVmCreation,
                .deleteVm(containerId: readerVmId, isCallerCancelled: false),
                .readEnded,
            ]
        )
    }

    /// Verifies that a reader whose stop failed holds the read until it
    /// exits, so the read never returns while its reader still runs.
    ///
    /// This schedule fixes the order for a correct read. A read that returned
    /// before its reader exited would usually record its end before the
    /// reader's exit, but not when it ran only after the test made the reader
    /// exit.
    @Test("When the deadline passes and the reader can't be stopped, the read throws the stop failure once the reader exits")
    func throwsStopFailureOnceReaderExits() async throws {
        let lifecycle = harness.createLifecycle(ReaderVmScript(command: .runsUntilResolved, failingSteps: [.stop]))
        let read = harness.startRead(through: lifecycle, until: harness.deadline)
        try await harness.eventLog.waitForEvent(.waitForCommandExit(containerId: readerVmId))
        harness.clock.updateNow(to: harness.deadline.instant)
        try await harness.eventLog.waitForEvent(.deleteVm(containerId: readerVmId, isCallerCancelled: false))

        await lifecycle.resolveCommand(containerId: readerVmId, with: readerOutput)
        let result = try await harness.waitForReadEnd(read)

        #expect(throws: ReaderVmStepFailure(step: .stop)) { try result.get() }
        #expect(
            harness.eventLog.events == [
                readerVmCreation,
                .startVm(containerId: readerVmId),
                .startEnded(containerId: readerVmId),
                .waitForCommandExit(containerId: readerVmId),
                .deleteVm(containerId: readerVmId, isCallerCancelled: false),
                .commandExited(containerId: readerVmId),
                .waitEnded(containerId: readerVmId),
                .readEnded,
            ]
        )
    }

    /// Verifies that a reader whose stop failed holds the read until it
    /// exits also when the deadline passed while its VM started, so the read
    /// begins deleting the VM as soon as the start ends.
    ///
    /// Once the start ends, the wait for the reader and the deletion run
    /// concurrently, so either may reach the lifecycle first, and the read
    /// must end after its reader in both orders.
    /// ``ReaderVmLifecycleFailureContractTests/endsLateWaitWhenCommandExits(harness:)``
    /// checks the order in which the deletion comes first.
    @Test("When the deadline passes while the VM starts and the reader can't be stopped, the read throws the stop failure once the reader exits")
    func throwsStopFailureOnceReaderExitsAfterLateStart() async throws {
        let lifecycle = harness.createLifecycle(
            ReaderVmScript(command: .runsUntilResolved, failingSteps: [.stop], holdsStart: true)
        )
        let read = harness.startRead(through: lifecycle, until: harness.deadline)
        try await harness.eventLog.waitForEvent(.startVm(containerId: readerVmId))
        harness.clock.updateNow(to: harness.deadline.instant)
        await lifecycle.resolveStart(containerId: readerVmId)
        try await harness.eventLog.waitForEvent(.deleteVm(containerId: readerVmId, isCallerCancelled: false))
        try await harness.eventLog.waitForEvent(.waitForCommandExit(containerId: readerVmId))

        await lifecycle.resolveCommand(containerId: readerVmId, with: readerOutput)
        let result = try await harness.waitForReadEnd(read)

        #expect(throws: ReaderVmStepFailure(step: .stop)) { try result.get() }
        harness.expectReadEndedAfterUnstoppedReader()
    }
}

/// Checks how ``readPageInVm(_:_:deadline:)`` ends when its caller is
/// cancelled: with `CancellationError`, after deleting its VM from a task
/// that isn't cancelled, so the deletion can still stop the reader, and only
/// once the reader can no longer run.
///
/// The reads run as in ``ReadPageInVmOutcomeTests``.
@Suite("Cancelling a page read in a VM", .timeLimit(.minutes(1)))
struct ReadPageInVmCancellationTests {
    /// This test's clock, event log, and page.
    private let harness: ReadPageInVmHarness

    /// Creates this test's harness.
    ///
    /// - Throws: `ExpectationFailedError` when the page's URL doesn't parse.
    init() throws {
        harness = try ReadPageInVmHarness()
    }

    /// Verifies that a read cancelled before it begins gets
    /// `CancellationError` from the creation, whose lifecycle deletes what it
    /// created, so the read starts and deletes nothing. Its reader would exit
    /// at once, so even a read that went on would end.
    @Test("A read cancelled before it begins throws CancellationError without starting or deleting a VM")
    func throwsCancellationBeforeCreation() async throws {
        let lifecycle = harness.createLifecycle(ReaderVmScript(command: .exitsAtStart(readerOutput)))
        let (url, deadline) = (harness.url, harness.deadline)

        // A task added to a cancelled group starts cancelled.
        let readEnd = await withThrowingTaskGroup(of: ReadPageOutcome.self) { group in
            group.cancelAll()
            group.addTask { try await readPageInVm(url, lifecycle, deadline: deadline) }
            return await group.nextResult()
        }

        let result = try #require(readEnd)
        #expect(throws: CancellationError.self) { try result.get() }
        #expect(harness.eventLog.events == [readerVmCreation])
    }

    /// Verifies that cancelling the read kills the reader by deleting its VM,
    /// from a task that isn't cancelled, and that the read's timer is gone.
    @Test("Cancelling a read while the reader runs deletes the VM from a task that isn't cancelled, then throws CancellationError")
    func throwsCancellationWhileReaderRuns() async throws {
        let lifecycle = harness.createLifecycle(ReaderVmScript(command: .runsUntilResolved))
        let read = harness.startRead(through: lifecycle, until: harness.deadline)
        try await harness.eventLog.waitForEvent(.waitForCommandExit(containerId: readerVmId))

        read.cancel()
        let result = try await harness.waitForReadEnd(read)

        #expect(throws: CancellationError.self) { try result.get() }
        #expect(
            harness.eventLog.events == [
                readerVmCreation,
                .startVm(containerId: readerVmId),
                .startEnded(containerId: readerVmId),
                .waitForCommandExit(containerId: readerVmId),
                .deleteVm(containerId: readerVmId, isCallerCancelled: false),
                .waitEnded(containerId: readerVmId),
                .readEnded,
            ]
        )
        #expect(harness.clock.pendingSleepCount == 0)
        await harness.expectReaderVmDeleted(in: lifecycle)
    }

    /// Verifies that the cancellation isn't hidden when the VM can't be
    /// deleted, nor the deletion failure by the cancellation.
    @Test("Cancelling a read while the reader runs throws both failures when the VM can't be deleted")
    func throwsCancellationAndDeletionFailure() async throws {
        let lifecycle = harness.createLifecycle(
            ReaderVmScript(command: .runsUntilResolved, failingSteps: [.deletion])
        )
        let read = harness.startRead(through: lifecycle, until: harness.deadline)
        try await harness.eventLog.waitForEvent(.waitForCommandExit(containerId: readerVmId))

        read.cancel()
        let result = try await harness.waitForReadEnd(read)

        let error = try #require(throws: CleanupAfterFailureError.self) { try result.get() }
        #expect(error.operationError is CancellationError)
        #expect(error.cleanupError as? ReaderVmStepFailure == ReaderVmStepFailure(step: .deletion))
        #expect(
            harness.eventLog.events == [
                readerVmCreation,
                .startVm(containerId: readerVmId),
                .startEnded(containerId: readerVmId),
                .waitForCommandExit(containerId: readerVmId),
                .deleteVm(containerId: readerVmId, isCallerCancelled: false),
                .waitEnded(containerId: readerVmId),
                .readEnded,
            ]
        )
    }

    /// Verifies that a reader whose stop failed holds a cancelled read until
    /// it exits, so the read never returns while its reader still runs: the
    /// read's cancellation doesn't end its wait for the reader.
    ///
    /// This schedule fixes the order for a correct read, as in
    /// ``ReadPageInVmFailureTests/throwsStopFailureOnceReaderExits()``.
    @Test("Cancelling a read whose reader can't be stopped throws both failures once the reader exits")
    func throwsCancellationAndStopFailureOnceReaderExits() async throws {
        let lifecycle = harness.createLifecycle(ReaderVmScript(command: .runsUntilResolved, failingSteps: [.stop]))
        let read = harness.startRead(through: lifecycle, until: harness.deadline)
        try await harness.eventLog.waitForEvent(.waitForCommandExit(containerId: readerVmId))
        read.cancel()
        try await harness.eventLog.waitForEvent(.deleteVm(containerId: readerVmId, isCallerCancelled: false))

        await lifecycle.resolveCommand(containerId: readerVmId, with: readerOutput)
        let result = try await harness.waitForReadEnd(read)

        let error = try #require(throws: CleanupAfterFailureError.self) { try result.get() }
        #expect(error.operationError is CancellationError)
        #expect(error.cleanupError as? ReaderVmStepFailure == ReaderVmStepFailure(step: .stop))
        #expect(
            harness.eventLog.events == [
                readerVmCreation,
                .startVm(containerId: readerVmId),
                .startEnded(containerId: readerVmId),
                .waitForCommandExit(containerId: readerVmId),
                .deleteVm(containerId: readerVmId, isCallerCancelled: false),
                .commandExited(containerId: readerVmId),
                .waitEnded(containerId: readerVmId),
                .readEnded,
            ]
        )
    }

    /// Verifies that a reader whose stop failed holds a read cancelled while
    /// its VM started until it exits, although the read begins deleting the
    /// VM as soon as the start ends.
    ///
    /// The wait for the reader and the deletion may reach the lifecycle in
    /// either order, as in
    /// ``ReadPageInVmFailureTests/throwsStopFailureOnceReaderExitsAfterLateStart()``.
    @Test("Cancelling a read while its VM starts, when the reader can't be stopped, throws both failures once the reader exits")
    func throwsCancellationAndStopFailureOnceReaderExitsAfterLateStart() async throws {
        let lifecycle = harness.createLifecycle(
            ReaderVmScript(command: .runsUntilResolved, failingSteps: [.stop], holdsStart: true)
        )
        let read = harness.startRead(through: lifecycle, until: harness.deadline)
        try await harness.eventLog.waitForEvent(.startVm(containerId: readerVmId))
        read.cancel()
        await lifecycle.resolveStart(containerId: readerVmId)
        try await harness.eventLog.waitForEvent(.deleteVm(containerId: readerVmId, isCallerCancelled: false))
        try await harness.eventLog.waitForEvent(.waitForCommandExit(containerId: readerVmId))

        await lifecycle.resolveCommand(containerId: readerVmId, with: readerOutput)
        let result = try await harness.waitForReadEnd(read)

        let error = try #require(throws: CleanupAfterFailureError.self) { try result.get() }
        #expect(error.operationError is CancellationError)
        #expect(error.cleanupError as? ReaderVmStepFailure == ReaderVmStepFailure(step: .stop))
        harness.expectReadEndedAfterUnstoppedReader()
    }
}
