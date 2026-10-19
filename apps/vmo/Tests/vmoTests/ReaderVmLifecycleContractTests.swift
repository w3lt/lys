import Foundation
import Testing
@testable import vmo

/// What the contract's commands write when they exit on their own: output on
/// both streams, one of them cut, and a failing exit code, which a wait
/// returns rather than throws.
private let failedCommandOutput = CommandOutput(
    stdout: CommandStreamOutput(bytes: Data("partial page\n".utf8), isTruncated: false),
    stderr: CommandStreamOutput(bytes: Data("Error: page not read\n".utf8), isTruncated: true),
    exitCode: 1
)

/// Container id of a VM that the lifecycle under test didn't create.
private let unknownVmId = ContainerId(text: "missing")

/// An implementation of ``ReaderVmLifecycle`` that the contract cases without
/// a VM run against. Every implementation is one.
enum ReaderVmLifecycleImplementation: CaseIterable, Sendable, CustomTestStringConvertible {
    /// ``InMemoryReaderVmLifecycle``.
    case inMemory
    /// ``ContainerizationReaderVmLifecycle``, over a container manager that
    /// can't boot a VM.
    case containerization

    /// The implementation's name in test results.
    var testDescription: String {
        switch self {
        case .inMemory: "InMemoryReaderVmLifecycle"
        case .containerization: "ContainerizationReaderVmLifecycle"
        }
    }

    /// Creates a lifecycle of this implementation, with no VMs.
    ///
    /// - Parameter containerRoot: Directory that holds a
    ///   ``ContainerizationReaderVmLifecycle``'s files.
    /// - Returns: The ready lifecycle.
    /// - Throws: Containerization's error when a
    ///   ``ContainerizationReaderVmLifecycle``'s image store can't be created.
    func createLifecycle(in containerRoot: TemporaryContainerRoot) throws -> any ReaderVmLifecycle {
        switch self {
        case .inMemory:
            InMemoryReaderVmLifecycle(script: ReaderVmScript(command: .runsUntilResolved), events: ReaderVmEventLog())
        case .containerization:
            ContainerizationReaderVmLifecycle(containerManager: try containerRoot.createContainerManager())
        }
    }
}

/// A ``ReaderVmLifecycle`` under the contract cases with VMs, with the test
/// controls through which the cases bring about the outcomes they check.
///
/// The cases check the lifecycle only through ``ReaderVmLifecycle``. The
/// controls and the log only arrange the cases' steps and order them.
struct ReaderVmContractSubject: Sendable {
    /// The implementation under test.
    let lifecycle: any ReaderVmLifecycle
    /// What the lifecycle was asked to do and what its VMs did, for the cases
    /// to wait for.
    let eventLog: ReaderVmEventLog
    /// Makes a VM's running command exit on its own, having written the
    /// output.
    let resolveCommand: @Sendable (_ containerId: ContainerId, _ output: CommandOutput) async -> Void
    /// Lets a VM's held start boot it.
    let resolveStart: @Sendable (_ containerId: ContainerId) async -> Void
}

/// An implementation of ``ReaderVmLifecycle`` that the contract cases with
/// VMs run against, created with the test controls those cases need.
///
/// ``ContainerizationReaderVmLifecycle`` isn't one. To run VMs in a test, it
/// needs a Linux kernel, which vmo finds only on one developer's Mac until
/// #200, and a test process signed with the
/// `com.apple.security.virtualization` entitlement, which `swift test`
/// doesn't give. The suites that use this list name the guarantees that stay
/// unchecked for ``ContainerizationReaderVmLifecycle``.
enum ReaderVmLifecycleHarness: CaseIterable, Sendable, CustomTestStringConvertible {
    /// ``InMemoryReaderVmLifecycle``, whose own test controls bring about the
    /// outcomes.
    case inMemory

    /// The implementation's name in test results.
    var testDescription: String {
        switch self {
        case .inMemory: "InMemoryReaderVmLifecycle"
        }
    }

    /// Creates a lifecycle of this implementation, with no VMs, and its test
    /// controls.
    ///
    /// - Parameter script: What the VMs' commands do, which steps the VM
    ///   mechanism fails with a ``ReaderVmStepFailure``, and whether starts
    ///   wait for ``ReaderVmContractSubject/resolveStart``.
    /// - Returns: The lifecycle with its controls and log.
    func createSubject(script: ReaderVmScript) -> ReaderVmContractSubject {
        switch self {
        case .inMemory: createInMemorySubject(script: script)
        }
    }
}

/// Creates an ``InMemoryReaderVmLifecycle`` with its own test controls.
///
/// - Parameter script: How the lifecycle's VMs behave.
/// - Returns: The lifecycle with its controls and log.
private func createInMemorySubject(script: ReaderVmScript) -> ReaderVmContractSubject {
    let eventLog = ReaderVmEventLog()
    let lifecycle = InMemoryReaderVmLifecycle(script: script, events: eventLog)
    return ReaderVmContractSubject(
        lifecycle: lifecycle,
        eventLog: eventLog,
        resolveCommand: { await lifecycle.resolveCommand(containerId: $0, with: $1) },
        resolveStart: { await lifecycle.resolveStart(containerId: $0) }
    )
}

/// Creates a VM that would read the example page with the reader image.
///
/// - Parameter subject: Lifecycle to create the VM in.
/// - Returns: The new VM's container id.
/// - Throws: The errors of ``ReaderVmLifecycle/createVm(imageReference:arguments:)``.
private func createReaderVm(in subject: ReaderVmContractSubject) async throws -> ContainerId {
    try await subject.lifecycle.createVm(imageReference: readPageImageReference, arguments: ["https://example.com/"])
}

/// Creates a VM as ``createReaderVm(in:)`` does, from a task that is
/// cancelled before the creation begins.
///
/// - Parameter subject: Lifecycle to create the VM in.
/// - Returns: How the creation ended, or `nil` when the task group gave no
///   result.
private func createReaderVmWhenCancelled(in subject: ReaderVmContractSubject) async -> Result<ContainerId, any Error>? {
    // A task added to a cancelled group starts cancelled.
    await withThrowingTaskGroup(of: ContainerId.self) { group in
        group.cancelAll()
        group.addTask { try await createReaderVm(in: subject) }
        return await group.nextResult()
    }
}

/// Starts waiting for a VM's command in a task of its own, so the case can
/// act while the wait is pending.
///
/// - Parameters:
///   - containerId: Container id of the VM.
///   - subject: Lifecycle that created the VM.
/// - Returns: The wait's task.
private func startCommandWait(
    for containerId: ContainerId,
    in subject: ReaderVmContractSubject
) -> Task<CommandOutput, any Error> {
    Task { try await subject.lifecycle.waitForCommandExit(containerId: containerId) }
}

/// Waits for a VM's command as ``startCommandWait(for:in:)`` does, from a
/// task that is cancelled before the wait begins.
///
/// - Parameters:
///   - containerId: Container id of the VM.
///   - subject: Lifecycle that created the VM.
/// - Returns: How the wait ended, or `nil` when the task group gave no
///   result.
private func waitForCommandExitWhenCancelled(
    for containerId: ContainerId,
    in subject: ReaderVmContractSubject
) async -> Result<CommandOutput, any Error>? {
    // A task added to a cancelled group starts cancelled.
    await withThrowingTaskGroup(of: CommandOutput.self) { group in
        group.cancelAll()
        group.addTask { try await subject.lifecycle.waitForCommandExit(containerId: containerId) }
        return await group.nextResult()
    }
}

/// Checks that a wait returned `expected`: the same bytes and truncation flag
/// of each stream, and the same exit code. ``CommandOutput`` has no equality
/// of its own.
///
/// - Parameters:
///   - output: What the wait returned.
///   - expected: What the command wrote and its exit code.
///   - sourceLocation: Where a failed check is reported; the caller's line by
///     default.
func expectOutput(
    _ output: CommandOutput,
    toEqual expected: CommandOutput,
    sourceLocation: SourceLocation = #_sourceLocation
) {
    #expect(output.stdout == expected.stdout, sourceLocation: sourceLocation)
    #expect(output.stderr == expected.stderr, sourceLocation: sourceLocation)
    #expect(output.exitCode == expected.exitCode, sourceLocation: sourceLocation)
}

/// Checks the contract of ``ReaderVmLifecycle`` that holds without a VM, with
/// the same assertions for every implementation.
@Suite("Reader VM lifecycle contract without a VM")
struct ReaderVmLifecycleContractTests {
    /// Directory holding a ``ContainerizationReaderVmLifecycle``'s image
    /// store.
    private let containerRoot: TemporaryContainerRoot

    /// Creates this test's container directory.
    ///
    /// - Throws: The file system's error when the directory can't be created.
    init() throws {
        containerRoot = try TemporaryContainerRoot()
    }

    /// Verifies that an id the lifecycle never returned names no VM.
    @Test(
        "Starting, waiting for, and deleting a VM the lifecycle didn't create fail as unknown",
        arguments: ReaderVmLifecycleImplementation.allCases
    )
    func rejectsUnknownVm(implementation: ReaderVmLifecycleImplementation) async throws {
        let lifecycle = try implementation.createLifecycle(in: containerRoot)

        await #expect(throws: ReaderVmLifecycleError.unknownVm(containerId: unknownVmId)) {
            try await lifecycle.startVm(containerId: unknownVmId)
        }
        await #expect(throws: ReaderVmLifecycleError.unknownVm(containerId: unknownVmId)) {
            try await lifecycle.waitForCommandExit(containerId: unknownVmId)
        }
        await #expect(throws: ReaderVmLifecycleError.unknownVm(containerId: unknownVmId)) {
            try await lifecycle.deleteVm(containerId: unknownVmId)
        }
    }
}

/// Checks the contract of ``ReaderVmLifecycle`` for VMs and their commands,
/// with the same assertions for every implementation that
/// ``ReaderVmLifecycleHarness`` lists.
///
/// These guarantees stay unchecked for ``ContainerizationReaderVmLifecycle``,
/// because running its VMs in a test needs a Linux kernel, which vmo finds only
/// on one developer's Mac until #200, and a test process signed with the
/// virtualization entitlement, which `swift test` doesn't give: that each VM
/// gets an id no other VM has had and runs nothing until it starts; that a
/// command's output and exit code reach every wait, concurrent or later; that a
/// VM starts once, and a failed start leaves a VM that only deletion ends; that
/// deleting a VM while it starts fails at once; that deleting a VM ends every
/// wait for it and leaves an id that names no VM; and that a pending wait holds
/// up no other operation.
@Suite("Reader VM lifecycle contract with VMs", .timeLimit(.minutes(1)))
struct ReaderVmLifecycleVmContractTests {
    /// Verifies that ids aren't reused, also after a deletion, and that a
    /// created VM's command doesn't run before the VM starts.
    @Test(
        "Each created VM gets an id no other VM has had, and its command doesn't run until the VM starts",
        arguments: ReaderVmLifecycleHarness.allCases
    )
    func createsUnstartedVms(harness: ReaderVmLifecycleHarness) async throws {
        let subject = harness.createSubject(script: ReaderVmScript(command: .exitsAtStart(failedCommandOutput)))

        let firstId = try await createReaderVm(in: subject)
        let secondId = try await createReaderVm(in: subject)
        try await subject.lifecycle.deleteVm(containerId: firstId)
        let thirdId = try await createReaderVm(in: subject)

        #expect(Set([firstId, secondId, thirdId]).count == 3)
        await #expect(throws: ReaderVmLifecycleError.notStarted(containerId: secondId)) {
            try await subject.lifecycle.waitForCommandExit(containerId: secondId)
        }
    }

    /// Verifies that concurrent waits and a wait after the exit all get the
    /// command's output, and that a failing exit code is returned, not
    /// thrown.
    @Test(
        "Every wait for a command, concurrent or after its exit, gets its output and exit code",
        arguments: ReaderVmLifecycleHarness.allCases
    )
    func returnsCommandOutputToEveryWait(harness: ReaderVmLifecycleHarness) async throws {
        let subject = harness.createSubject(script: ReaderVmScript(command: .runsUntilResolved))
        let containerId = try await createReaderVm(in: subject)
        try await subject.lifecycle.startVm(containerId: containerId)
        let firstWait = startCommandWait(for: containerId, in: subject)
        let secondWait = startCommandWait(for: containerId, in: subject)
        try await subject.eventLog.waitForEvent(.waitForCommandExit(containerId: containerId), count: 2)

        await subject.resolveCommand(containerId, failedCommandOutput)
        try await subject.eventLog.waitForEvent(.waitEnded(containerId: containerId), count: 2)
        let laterOutput = try await subject.lifecycle.waitForCommandExit(containerId: containerId)

        expectOutput(try await firstWait.value, toEqual: failedCommandOutput)
        expectOutput(try await secondWait.value, toEqual: failedCommandOutput)
        expectOutput(laterOutput, toEqual: failedCommandOutput)
    }

    /// Verifies that a started VM rejects another start and keeps running
    /// its command.
    @Test("A started VM can't start again", arguments: ReaderVmLifecycleHarness.allCases)
    func rejectsSecondStart(harness: ReaderVmLifecycleHarness) async throws {
        let subject = harness.createSubject(script: ReaderVmScript(command: .exitsAtStart(failedCommandOutput)))
        let containerId = try await createReaderVm(in: subject)
        try await subject.lifecycle.startVm(containerId: containerId)

        await #expect(throws: ReaderVmLifecycleError.alreadyStarted(containerId: containerId)) {
            try await subject.lifecycle.startVm(containerId: containerId)
        }

        let output = try await subject.lifecycle.waitForCommandExit(containerId: containerId)
        expectOutput(output, toEqual: failedCommandOutput)
    }

    /// Verifies that a failed start leaves a VM that can't start again or
    /// run its command, and that deleting it succeeds.
    @Test(
        "A failed start throws the mechanism's failure and leaves a VM that only deletion ends",
        arguments: ReaderVmLifecycleHarness.allCases
    )
    func leavesFailedStartForDeletion(harness: ReaderVmLifecycleHarness) async throws {
        let subject = harness.createSubject(
            script: ReaderVmScript(command: .exitsAtStart(failedCommandOutput), failingSteps: [.start])
        )
        let containerId = try await createReaderVm(in: subject)

        await #expect(throws: ReaderVmStepFailure(step: .start)) {
            try await subject.lifecycle.startVm(containerId: containerId)
        }

        await #expect(throws: ReaderVmLifecycleError.alreadyStarted(containerId: containerId)) {
            try await subject.lifecycle.startVm(containerId: containerId)
        }
        await #expect(throws: ReaderVmLifecycleError.notStarted(containerId: containerId)) {
            try await subject.lifecycle.waitForCommandExit(containerId: containerId)
        }
        try await subject.lifecycle.deleteVm(containerId: containerId)
        await #expect(throws: ReaderVmLifecycleError.unknownVm(containerId: containerId)) {
            try await subject.lifecycle.deleteVm(containerId: containerId)
        }
    }

    /// Verifies that a starting VM can't be deleted, which fails without
    /// waiting for the start, and that it can be once the start ends.
    @Test(
        "Deleting a VM while it starts fails as a start in progress, and succeeds once the start ends",
        arguments: ReaderVmLifecycleHarness.allCases
    )
    func rejectsDeletionWhileStarting(harness: ReaderVmLifecycleHarness) async throws {
        let subject = harness.createSubject(script: ReaderVmScript(command: .runsUntilResolved, holdsStart: true))
        let containerId = try await createReaderVm(in: subject)
        let start = Task { try await subject.lifecycle.startVm(containerId: containerId) }
        try await subject.eventLog.waitForEvent(.startVm(containerId: containerId))

        await #expect(throws: ReaderVmLifecycleError.startInProgress(containerId: containerId)) {
            try await subject.lifecycle.deleteVm(containerId: containerId)
        }
        await #expect(throws: ReaderVmLifecycleError.notStarted(containerId: containerId)) {
            try await subject.lifecycle.waitForCommandExit(containerId: containerId)
        }

        await subject.resolveStart(containerId)
        try await subject.eventLog.waitForEvent(.startEnded(containerId: containerId))
        try await start.value
        try await subject.lifecycle.deleteVm(containerId: containerId)
    }

    /// Verifies that deleting a started VM ends every wait for its command,
    /// and that afterwards the VM's id names no VM.
    @Test(
        "Deleting a started VM ends every wait for it and leaves an id that names no VM",
        arguments: ReaderVmLifecycleHarness.allCases
    )
    func endsWaitsOnDeletion(harness: ReaderVmLifecycleHarness) async throws {
        let subject = harness.createSubject(script: ReaderVmScript(command: .runsUntilResolved))
        let containerId = try await createReaderVm(in: subject)
        try await subject.lifecycle.startVm(containerId: containerId)
        let firstWait = startCommandWait(for: containerId, in: subject)
        let secondWait = startCommandWait(for: containerId, in: subject)
        try await subject.eventLog.waitForEvent(.waitForCommandExit(containerId: containerId), count: 2)

        try await subject.lifecycle.deleteVm(containerId: containerId)
        try await subject.eventLog.waitForEvent(.waitEnded(containerId: containerId), count: 2)

        await #expect(throws: ReaderVmLifecycleError.unknownVm(containerId: containerId)) { try await firstWait.value }
        await #expect(throws: ReaderVmLifecycleError.unknownVm(containerId: containerId)) { try await secondWait.value }
        await #expect(throws: ReaderVmLifecycleError.unknownVm(containerId: containerId)) {
            try await subject.lifecycle.startVm(containerId: containerId)
        }
        await #expect(throws: ReaderVmLifecycleError.unknownVm(containerId: containerId)) {
            try await subject.lifecycle.waitForCommandExit(containerId: containerId)
        }
        await #expect(throws: ReaderVmLifecycleError.unknownVm(containerId: containerId)) {
            try await subject.lifecycle.deleteVm(containerId: containerId)
        }
    }

    /// Verifies that a wait that hasn't ended holds up no operation on
    /// another VM. Deleting the waited VM at the end ends the wait.
    @Test(
        "While a wait for one VM is pending, another VM is created, started, waited for, and deleted",
        arguments: ReaderVmLifecycleHarness.allCases
    )
    func runsOtherVmDuringWait(harness: ReaderVmLifecycleHarness) async throws {
        let subject = harness.createSubject(script: ReaderVmScript(command: .runsUntilResolved))
        let waitedId = try await createReaderVm(in: subject)
        try await subject.lifecycle.startVm(containerId: waitedId)
        let wait = startCommandWait(for: waitedId, in: subject)
        try await subject.eventLog.waitForEvent(.waitForCommandExit(containerId: waitedId))

        let otherId = try await createReaderVm(in: subject)
        try await subject.lifecycle.startVm(containerId: otherId)
        await subject.resolveCommand(otherId, failedCommandOutput)
        let otherOutput = try await subject.lifecycle.waitForCommandExit(containerId: otherId)
        try await subject.lifecycle.deleteVm(containerId: otherId)

        expectOutput(otherOutput, toEqual: failedCommandOutput)
        try await subject.lifecycle.deleteVm(containerId: waitedId)
        try await subject.eventLog.waitForEvent(.waitEnded(containerId: waitedId))
        await #expect(throws: ReaderVmLifecycleError.unknownVm(containerId: waitedId)) { try await wait.value }
    }
}

/// Checks the contract of ``ReaderVmLifecycle`` when the VM mechanism fails
/// and when a caller is cancelled, with the same assertions for every
/// implementation that ``ReaderVmLifecycleHarness`` lists. Each case makes the
/// mechanism fail the steps it names, with a ``ReaderVmStepFailure``.
///
/// These guarantees stay unchecked for ``ContainerizationReaderVmLifecycle``,
/// because running its VMs in a test needs a Linux kernel, which vmo finds only
/// on one developer's Mac until #200, and a test process signed with the
/// virtualization entitlement, which `swift test` doesn't give: that a failed
/// creation throws the mechanism's failure, or both failures when deleting what
/// it left fails too; that a cancelled caller's creation throws
/// `CancellationError`, or both failures, so the caller gets no VM; that a
/// cancelled caller's wait throws `CancellationError`, also after the command
/// exited, and leaves the command and the other waits running; that a
/// failed wait throws the mechanism's failure; and that a failed stop or
/// deletion throws as documented and leaves the VM unavailable, a command whose
/// stop failed ending its waits only when it exits. Checking most of them also
/// needs a way to make a step of Containerization fail on demand.
/// ``ContainerizationReaderVmLifecycleTests`` checks, without a VM, what
/// ``ContainerizationReaderVmLifecycle`` does once closed.
@Suite("Reader VM lifecycle contract when the VM mechanism fails", .timeLimit(.minutes(1)))
struct ReaderVmLifecycleFailureContractTests {
    /// Verifies that a creation failure reaches the caller unchanged.
    @Test("A failed creation throws the mechanism's failure", arguments: ReaderVmLifecycleHarness.allCases)
    func throwsCreationFailure(harness: ReaderVmLifecycleHarness) async throws {
        let subject = harness.createSubject(
            script: ReaderVmScript(command: .runsUntilResolved, failingSteps: [.creation])
        )

        await #expect(throws: ReaderVmStepFailure(step: .creation)) {
            try await createReaderVm(in: subject)
        }
    }

    /// Verifies that neither failure hides the other when what a failed
    /// creation left can't be deleted.
    @Test(
        "A failed creation whose leftovers can't be deleted throws both failures",
        arguments: ReaderVmLifecycleHarness.allCases
    )
    func throwsCreationAndCleanupFailures(harness: ReaderVmLifecycleHarness) async throws {
        let subject = harness.createSubject(
            script: ReaderVmScript(command: .runsUntilResolved, failingSteps: [.creation, .deletion])
        )

        let error = try await #require(throws: CleanupAfterFailureError.self) {
            try await createReaderVm(in: subject)
        }
        #expect(error.operationError as? ReaderVmStepFailure == ReaderVmStepFailure(step: .creation))
        #expect(error.cleanupError as? ReaderVmStepFailure == ReaderVmStepFailure(step: .deletion))
    }

    /// Verifies that a caller cancelled before the creation gets no VM.
    @Test(
        "A creation whose caller is cancelled throws CancellationError, so the caller gets no VM",
        arguments: ReaderVmLifecycleHarness.allCases
    )
    func throwsCancellationForCancelledCreation(harness: ReaderVmLifecycleHarness) async throws {
        let subject = harness.createSubject(script: ReaderVmScript(command: .runsUntilResolved))

        let result = try #require(await createReaderVmWhenCancelled(in: subject))

        #expect(throws: CancellationError.self) { try result.get() }
    }

    /// Verifies that neither the cancellation nor the cleanup failure hides
    /// the other when what a cancelled creation left can't be deleted.
    @Test(
        "A creation whose caller is cancelled and whose leftovers can't be deleted throws both failures",
        arguments: ReaderVmLifecycleHarness.allCases
    )
    func throwsCancellationAndCleanupFailures(harness: ReaderVmLifecycleHarness) async throws {
        let subject = harness.createSubject(
            script: ReaderVmScript(command: .runsUntilResolved, failingSteps: [.deletion])
        )

        let result = try #require(await createReaderVmWhenCancelled(in: subject))

        let error = try #require(throws: CleanupAfterFailureError.self) { try result.get() }
        #expect(error.operationError is CancellationError)
        #expect(error.cleanupError as? ReaderVmStepFailure == ReaderVmStepFailure(step: .deletion))
    }

    /// Verifies that cancelling one caller ends that caller's wait at once,
    /// while the command runs on and the other wait still gets its output.
    ///
    /// The cancellation can reach the wait before or after the lifecycle
    /// keeps it, and both must end it the same way;
    /// ``throwsCancellationForCancelledWait(harness:)`` checks a caller
    /// cancelled before its wait began.
    @Test(
        "Cancelling one wait for a command ends only that wait, with CancellationError, and the other wait gets the output",
        arguments: ReaderVmLifecycleHarness.allCases
    )
    func endsOnlyCancelledWait(harness: ReaderVmLifecycleHarness) async throws {
        let subject = harness.createSubject(script: ReaderVmScript(command: .runsUntilResolved))
        let containerId = try await createReaderVm(in: subject)
        try await subject.lifecycle.startVm(containerId: containerId)
        let wait = startCommandWait(for: containerId, in: subject)
        let cancelledWait = startCommandWait(for: containerId, in: subject)
        try await subject.eventLog.waitForEvent(.waitForCommandExit(containerId: containerId), count: 2)

        cancelledWait.cancel()
        try await subject.eventLog.waitForEvent(.waitEnded(containerId: containerId))
        await subject.resolveCommand(containerId, failedCommandOutput)
        try await subject.eventLog.waitForEvent(.waitEnded(containerId: containerId), count: 2)

        await #expect(throws: CancellationError.self) { try await cancelledWait.value }
        expectOutput(try await wait.value, toEqual: failedCommandOutput)
    }

    /// Verifies that a caller cancelled before it waits gets
    /// `CancellationError` instead of the output of a command that has
    /// already exited, and that the output stays for a later wait.
    @Test(
        "A wait whose caller is already cancelled throws CancellationError, also when the command has exited",
        arguments: ReaderVmLifecycleHarness.allCases
    )
    func throwsCancellationForCancelledWait(harness: ReaderVmLifecycleHarness) async throws {
        let subject = harness.createSubject(script: ReaderVmScript(command: .exitsAtStart(failedCommandOutput)))
        let containerId = try await createReaderVm(in: subject)
        try await subject.lifecycle.startVm(containerId: containerId)

        let result = try #require(await waitForCommandExitWhenCancelled(for: containerId, in: subject))

        #expect(throws: CancellationError.self) { try result.get() }
        let laterOutput = try await subject.lifecycle.waitForCommandExit(containerId: containerId)
        expectOutput(laterOutput, toEqual: failedCommandOutput)
    }

    /// Verifies that a failed wait reaches the caller unchanged, after which
    /// the VM can still be deleted.
    @Test(
        "A failed wait throws the mechanism's failure, and the VM can still be deleted",
        arguments: ReaderVmLifecycleHarness.allCases
    )
    func throwsWaitFailure(harness: ReaderVmLifecycleHarness) async throws {
        let subject = harness.createSubject(
            script: ReaderVmScript(command: .runsUntilResolved, failingSteps: [.wait])
        )
        let containerId = try await createReaderVm(in: subject)
        try await subject.lifecycle.startVm(containerId: containerId)

        await #expect(throws: ReaderVmStepFailure(step: .wait)) {
            try await subject.lifecycle.waitForCommandExit(containerId: containerId)
        }

        try await subject.lifecycle.deleteVm(containerId: containerId)
    }

    /// Verifies that a VM whose stop failed is deleted anyway, and that its
    /// command, which runs on, ends the waits for it only when it exits.
    ///
    /// This schedule fixes the order for a correct implementation. One that
    /// ended the wait at the deletion would usually record the wait's end
    /// before the command's exit, but not when the wait ran only after the
    /// case made the command exit.
    @Test(
        "A failed stop throws the mechanism's failure after deleting the VM, and its waits end only when its command exits",
        arguments: ReaderVmLifecycleHarness.allCases
    )
    func deletesVmAfterStopFailure(harness: ReaderVmLifecycleHarness) async throws {
        let subject = harness.createSubject(
            script: ReaderVmScript(command: .runsUntilResolved, failingSteps: [.stop])
        )
        let containerId = try await createReaderVm(in: subject)
        try await subject.lifecycle.startVm(containerId: containerId)
        let wait = startCommandWait(for: containerId, in: subject)
        try await subject.eventLog.waitForEvent(.waitForCommandExit(containerId: containerId))

        await #expect(throws: ReaderVmStepFailure(step: .stop)) {
            try await subject.lifecycle.deleteVm(containerId: containerId)
        }
        await #expect(throws: ReaderVmLifecycleError.unknownVm(containerId: containerId)) {
            try await subject.lifecycle.deleteVm(containerId: containerId)
        }
        await subject.resolveCommand(containerId, failedCommandOutput)
        try await subject.eventLog.waitForEvent(.waitEnded(containerId: containerId))

        await #expect(throws: ReaderVmLifecycleError.unknownVm(containerId: containerId)) { try await wait.value }
        #expect(
            Array(subject.eventLog.events.suffix(2)) == [
                .commandExited(containerId: containerId),
                .waitEnded(containerId: containerId),
            ]
        )
    }

    /// Verifies that a deletion failure reaches the caller unchanged and that
    /// the VM is then no longer available.
    @Test(
        "A failed deletion throws the mechanism's failure and leaves the VM unavailable",
        arguments: ReaderVmLifecycleHarness.allCases
    )
    func throwsDeletionFailure(harness: ReaderVmLifecycleHarness) async throws {
        let subject = harness.createSubject(
            script: ReaderVmScript(command: .exitsAtStart(failedCommandOutput), failingSteps: [.deletion])
        )
        let containerId = try await createReaderVm(in: subject)
        try await subject.lifecycle.startVm(containerId: containerId)

        await #expect(throws: ReaderVmStepFailure(step: .deletion)) {
            try await subject.lifecycle.deleteVm(containerId: containerId)
        }

        await #expect(throws: ReaderVmLifecycleError.unknownVm(containerId: containerId)) {
            try await subject.lifecycle.startVm(containerId: containerId)
        }
        await #expect(throws: ReaderVmLifecycleError.unknownVm(containerId: containerId)) {
            try await subject.lifecycle.waitForCommandExit(containerId: containerId)
        }
        await #expect(throws: ReaderVmLifecycleError.unknownVm(containerId: containerId)) {
            try await subject.lifecycle.deleteVm(containerId: containerId)
        }
    }

    /// Verifies that neither failure hides the other when stopping and
    /// deleting a VM both fail, and that the VM is then no longer available.
    @Test(
        "A failed stop and a failed deletion throw both failures and leave the VM unavailable",
        arguments: ReaderVmLifecycleHarness.allCases
    )
    func throwsStopAndDeletionFailures(harness: ReaderVmLifecycleHarness) async throws {
        let subject = harness.createSubject(
            script: ReaderVmScript(command: .exitsAtStart(failedCommandOutput), failingSteps: [.stop, .deletion])
        )
        let containerId = try await createReaderVm(in: subject)
        try await subject.lifecycle.startVm(containerId: containerId)

        let error = try await #require(throws: CleanupAfterFailureError.self) {
            try await subject.lifecycle.deleteVm(containerId: containerId)
        }

        #expect(error.operationError as? ReaderVmStepFailure == ReaderVmStepFailure(step: .stop))
        #expect(error.cleanupError as? ReaderVmStepFailure == ReaderVmStepFailure(step: .deletion))
        await #expect(throws: ReaderVmLifecycleError.unknownVm(containerId: containerId)) {
            try await subject.lifecycle.deleteVm(containerId: containerId)
        }
    }
}
