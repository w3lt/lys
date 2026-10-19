@testable import vmo

/// A step of a VM's life that an ``InMemoryReaderVmLifecycle`` can be
/// scripted to fail.
enum ReaderVmStep: Hashable, Sendable {
    /// Creating the VM.
    case creation
    /// Booting the VM and starting its command.
    case start
    /// Waiting for the command to exit: every wait fails once the VM starts.
    case wait
    /// Stopping a started VM while deleting it: the command then runs on.
    case stop
    /// Deleting the VM's files and address, also after a failed creation.
    case deletion
}

/// The failure that an ``InMemoryReaderVmLifecycle`` throws, as its VM
/// mechanism's error, for a step its script makes fail.
struct ReaderVmStepFailure: Error, Equatable {
    /// The step that failed.
    let step: ReaderVmStep
}

/// What the command of each VM of an ``InMemoryReaderVmLifecycle`` does once
/// its VM starts.
enum ReaderVmCommand: Sendable {
    /// Exits as soon as its VM starts, having written this output.
    case exitsAtStart(CommandOutput)
    /// Runs until ``InMemoryReaderVmLifecycle/resolveCommand(containerId:with:)``
    /// makes it exit or its VM's stop kills it.
    case runsUntilResolved
}

/// How the VMs of an ``InMemoryReaderVmLifecycle`` behave, as a test arranges
/// it.
struct ReaderVmScript: Sendable {
    /// What each VM's command does once its VM starts.
    let command: ReaderVmCommand
    /// The steps that fail, each with a ``ReaderVmStepFailure``.
    let failingSteps: Set<ReaderVmStep>
    /// Whether each start waits for
    /// ``InMemoryReaderVmLifecycle/resolveStart(containerId:)`` before it
    /// boots the VM, so that a test can act while the VM starts.
    let holdsStart: Bool

    /// Creates a script.
    ///
    /// - Parameters:
    ///   - command: What each VM's command does once its VM starts.
    ///   - failingSteps: The steps that fail; none by default.
    ///   - holdsStart: Whether each start waits for the test; by default, it
    ///     doesn't.
    init(command: ReaderVmCommand, failingSteps: Set<ReaderVmStep> = [], holdsStart: Bool = false) {
        self.command = command
        self.failingSteps = failingSteps
        self.holdsStart = holdsStart
    }
}

/// A VM of an ``InMemoryReaderVmLifecycle`` that hasn't been deleted, in the
/// phase it has reached. The phases are those ``VmManager`` tracks.
private enum InMemoryVmPhase: Equatable {
    /// Created and not started.
    case created
    /// Its start has begun and not ended.
    case starting
    /// Its command started.
    case started
    /// Its start failed, so only deleting it remains.
    case startFailed
    /// Its deletion has begun, or failed and left it unavailable.
    case deleting
}

/// The command of a VM that started.
private enum InMemoryCommandRun {
    /// It runs; these waits are suspended until it ends.
    case running(waits: [CheckedContinuation<Result<CommandOutput, any Error>, Never>])
    /// It ended; every wait for it gets this.
    case ended(Result<CommandOutput, any Error>)
}

/// Owns in-memory VMs that follow a test's script, to stand in for
/// ``VmManager`` as a ``ReaderVmLifecycle``, while keeping every guarantee of
/// that contract.
///
/// Its VMs boot nothing. Each VM's command does what the script's
/// ``ReaderVmScript/command`` says, and each step in
/// ``ReaderVmScript/failingSteps`` fails with a ``ReaderVmStepFailure``. It
/// is never closed, so it never throws ``VmManagerError/closed``. It records
/// every call, the end of every start and wait, and what its VMs do in its
/// ``ReaderVmEventLog``, and names its VMs `vm-1`, `vm-2`, and so on, in the
/// order their creation was called.
///
/// Invariant: `vms` holds the VMs created and not deleted, each in the phase
/// it has reached. `commandRuns` holds the command of every VM that started,
/// running or ended, also after its VM is deleted, because a command whose
/// stop failed runs on. `startHolds` holds the held starts, whose VMs are
/// starting. It owns no resource.
///
/// Concurrency model: concurrent. The actor runs one state change at a time;
/// a held start and a wait for a running command suspend without holding up
/// other operations, as ``VmManager``'s do.
actor InMemoryReaderVmLifecycle: ReaderVmLifecycle {
    /// How the VMs behave.
    private let script: ReaderVmScript
    /// Where the calls and what the VMs do are recorded.
    private let events: ReaderVmEventLog
    /// The VMs created and not deleted, keyed by container id.
    private var vms: [String: InMemoryVmPhase] = [:]
    /// The command of every VM that started, keyed by container id.
    private var commandRuns: [String: InMemoryCommandRun] = [:]
    /// The held starts, keyed by container id.
    private var startHolds: [String: CheckedContinuation<Void, Never>] = [:]
    /// How many VMs creation has named.
    private var namedVmCount = 0

    /// Creates a lifecycle with no VMs.
    ///
    /// - Parameters:
    ///   - script: How its VMs behave.
    ///   - events: Where it records its calls and what its VMs do.
    init(script: ReaderVmScript, events: ReaderVmEventLog) {
        self.script = script
        self.events = events
    }

    /// Implements ``ReaderVmLifecycle/createVm(imageReference:arguments:)``
    /// in memory.
    ///
    /// The creation fails when the script makes ``ReaderVmStep/creation``
    /// fail. A caller cancelled by the time the creation ends gets
    /// `CancellationError`. Deleting what either left fails when the script
    /// makes ``ReaderVmStep/deletion`` fail, which leaves the VM deleting.
    ///
    /// - Parameters:
    ///   - imageReference: The protocol operation's image, only recorded.
    ///   - arguments: The protocol operation's arguments, only recorded.
    /// - Returns: The new VM's container id.
    /// - Throws: The errors of the protocol operation, with
    ///   ``ReaderVmStepFailure`` as the mechanism's.
    func createVm(imageReference: String, arguments: [String]) throws -> String {
        events.addEvent(.createVm(imageReference: imageReference, arguments: arguments))
        namedVmCount += 1
        let containerId = "vm-\(namedVmCount)"
        if let creationError = findCreationError() {
            throw deleteFailedVm(containerId, creationError: creationError)
        }
        vms[containerId] = .created
        return containerId
    }

    /// Implements ``ReaderVmLifecycle/startVm(containerId:)`` in memory.
    ///
    /// When the script holds starts, the VM stays starting until
    /// ``resolveStart(containerId:)``. The start then fails when the script
    /// makes ``ReaderVmStep/start`` fail; otherwise the command starts as the
    /// script says. Cancelling the caller doesn't interrupt the start.
    ///
    /// - Parameter containerId: The protocol operation's container id.
    /// - Throws: The errors of the protocol operation, with
    ///   ``ReaderVmStepFailure`` as the mechanism's.
    func startVm(containerId: String) async throws {
        events.addEvent(.startVm(containerId: containerId))
        defer { events.addEvent(.startEnded(containerId: containerId)) }
        switch vms[containerId] {
        case .created:
            vms[containerId] = .starting
        case .starting, .started, .startFailed:
            throw VmManagerError.alreadyStarted(containerId: containerId)
        case .deleting, nil:
            throw VmManagerError.unknownVm(containerId: containerId)
        }
        if script.holdsStart {
            // Every other operation on a starting VM fails without changing
            // it, so the VM is still starting when the hold ends.
            await withCheckedContinuation { startHolds[containerId] = $0 }
        }
        guard !script.failingSteps.contains(.start) else {
            vms[containerId] = .startFailed
            throw ReaderVmStepFailure(step: .start)
        }
        commandRuns[containerId] = buildCommandRun()
        vms[containerId] = .started
    }

    /// Implements ``ReaderVmLifecycle/waitForCommandExit(containerId:)`` in
    /// memory.
    ///
    /// Every wait fails as soon as the VM starts when the script makes
    /// ``ReaderVmStep/wait`` fail.
    ///
    /// - Parameter containerId: The protocol operation's container id.
    /// - Returns: The output of the script's command, or the output that
    ///   ``resolveCommand(containerId:with:)`` gave it.
    /// - Throws: The errors of the protocol operation, with
    ///   ``ReaderVmStepFailure`` as the mechanism's.
    func waitForCommandExit(containerId: String) async throws -> CommandOutput {
        events.addEvent(.waitForCommandExit(containerId: containerId))
        defer { events.addEvent(.waitEnded(containerId: containerId)) }
        _ = try getCommandRun(of: containerId)
        let commandEnd = await waitForCommandEnd(of: containerId)
        // Deleting the VM stops the command, which then ended because it was
        // killed, not on its own.
        _ = try getCommandRun(of: containerId)
        return try commandEnd.get()
    }

    /// Implements ``ReaderVmLifecycle/deleteVm(containerId:)`` in memory.
    ///
    /// Stopping a started VM fails when the script makes ``ReaderVmStep/stop``
    /// fail, which leaves its command running until
    /// ``resolveCommand(containerId:with:)``. Deleting the VM's files fails
    /// when the script makes ``ReaderVmStep/deletion`` fail, which leaves the
    /// VM deleting. Cancelling the caller doesn't interrupt the deletion; the
    /// log records whether the caller was cancelled.
    ///
    /// - Parameter containerId: The protocol operation's container id.
    /// - Throws: The errors of the protocol operation, with
    ///   ``ReaderVmStepFailure`` as the mechanism's.
    func deleteVm(containerId: String) throws {
        events.addEvent(.deleteVm(containerId: containerId, isCallerCancelled: Task.isCancelled))
        let phase = vms[containerId]
        switch phase {
        case .created, .started, .startFailed:
            vms[containerId] = .deleting
        case .starting:
            throw VmManagerError.startInProgress(containerId: containerId)
        case .deleting, nil:
            throw VmManagerError.unknownVm(containerId: containerId)
        }
        let stopFailure = phase == .started ? stopCommand(of: containerId) : nil
        guard !script.failingSteps.contains(.deletion) else {
            let deletionFailure = ReaderVmStepFailure(step: .deletion)
            guard let stopFailure else {
                throw deletionFailure
            }
            throw CleanupAfterFailureError(operationError: stopFailure, cleanupError: deletionFailure)
        }
        vms[containerId] = nil
        if let stopFailure {
            throw stopFailure
        }
    }

    /// Makes a running command exit on its own, having written `output`.
    ///
    /// It also works on the command of a VM that was deleted after its stop
    /// failed, which runs on.
    ///
    /// - Parameters:
    ///   - containerId: Container id of the command's VM.
    ///   - output: What the command wrote, and its exit code.
    /// - Precondition: The command is running.
    func resolveCommand(containerId: String, with output: CommandOutput) {
        events.addEvent(.commandExited(containerId: containerId))
        resolveCommandRun(of: containerId, with: .success(output))
    }

    /// Lets a held start boot its VM.
    ///
    /// - Parameter containerId: Container id of the VM whose start is held.
    /// - Precondition: The script holds starts, and this VM's start is held.
    func resolveStart(containerId: String) {
        guard let startHold = startHolds.removeValue(forKey: containerId) else {
            preconditionFailure("resolveStart(containerId:) needs a held start")
        }
        startHold.resume()
    }

    /// Finds why a creation fails, as ``VmManager`` learns it: from the
    /// mechanism, then from cancellation once the mechanism is done.
    ///
    /// - Returns: The creation failure when the script makes
    ///   ``ReaderVmStep/creation`` fail; otherwise `CancellationError` when
    ///   the caller is cancelled; otherwise `nil`, because the creation
    ///   succeeds.
    private func findCreationError() -> (any Error)? {
        guard !script.failingSteps.contains(.creation) else {
            return ReaderVmStepFailure(step: .creation)
        }
        return Task.isCancelled ? CancellationError() : nil
    }

    /// Deletes what a failed creation left.
    ///
    /// - Parameters:
    ///   - containerId: Container id of the VM whose creation failed.
    ///   - creationError: Why the creation failed.
    /// - Returns: The error for the creation to throw: `creationError` when
    ///   nothing is left, or a ``CleanupAfterFailureError`` with the deletion
    ///   failure when the script makes ``ReaderVmStep/deletion`` fail, after
    ///   which the VM stays deleting.
    private func deleteFailedVm(_ containerId: String, creationError: any Error) -> any Error {
        guard script.failingSteps.contains(.deletion) else {
            return creationError
        }
        vms[containerId] = .deleting
        return CleanupAfterFailureError(operationError: creationError, cleanupError: ReaderVmStepFailure(step: .deletion))
    }

    /// Builds the command of a VM that just started, as the script says.
    ///
    /// - Returns: A command whose waits fail at once when the script makes
    ///   ``ReaderVmStep/wait`` fail; otherwise the script's command.
    private func buildCommandRun() -> InMemoryCommandRun {
        guard !script.failingSteps.contains(.wait) else {
            return .ended(.failure(ReaderVmStepFailure(step: .wait)))
        }
        return switch script.command {
        case .exitsAtStart(let output): .ended(.success(output))
        case .runsUntilResolved: .running(waits: [])
        }
    }

    /// Gets the command of a VM that started and hasn't been deleted.
    ///
    /// - Parameter containerId: Container id of the VM.
    /// - Returns: The VM's command.
    /// - Throws: ``VmManagerError/unknownVm(containerId:)`` when no VM with
    ///   this id is available. ``VmManagerError/notStarted(containerId:)``
    ///   when its command hasn't started.
    private func getCommandRun(of containerId: String) throws -> InMemoryCommandRun {
        switch vms[containerId] {
        case .started:
            guard let commandRun = commandRuns[containerId] else {
                preconditionFailure("A started VM's command has a run")
            }
            return commandRun
        case .created, .starting, .startFailed:
            throw VmManagerError.notStarted(containerId: containerId)
        case .deleting, nil:
            throw VmManagerError.unknownVm(containerId: containerId)
        }
    }

    /// Suspends until the command of a VM that started ends, and returns how
    /// it ended. Cancellation doesn't end the wait.
    ///
    /// - Parameter containerId: Container id of a VM whose command started.
    /// - Returns: The command's output, or why waiting for it failed.
    private func waitForCommandEnd(of containerId: String) async -> Result<CommandOutput, any Error> {
        switch commandRuns[containerId] {
        case .ended(let commandEnd):
            return commandEnd
        case .running(let waits):
            return await withCheckedContinuation { wait in
                commandRuns[containerId] = .running(waits: waits + [wait])
            }
        case nil:
            preconditionFailure("Only the command of a VM that started is waited for")
        }
    }

    /// Ends a running command and resumes every wait for it.
    ///
    /// - Parameters:
    ///   - containerId: Container id of the command's VM.
    ///   - commandEnd: How the command ended.
    /// - Precondition: The command is running.
    private func resolveCommandRun(of containerId: String, with commandEnd: Result<CommandOutput, any Error>) {
        guard case .running(let waits) = commandRuns[containerId] else {
            preconditionFailure("Only a running command ends")
        }
        commandRuns[containerId] = .ended(commandEnd)
        waits.forEach { $0.resume(returning: commandEnd) }
    }

    /// Stops a started VM's command, as its deletion does first.
    ///
    /// - Parameter containerId: Container id of a started VM that is being
    ///   deleted.
    /// - Returns: The stop failure when the script makes ``ReaderVmStep/stop``
    ///   fail, which leaves the command running; otherwise `nil`, with a
    ///   running command killed.
    private func stopCommand(of containerId: String) -> ReaderVmStepFailure? {
        guard !script.failingSteps.contains(.stop) else {
            return ReaderVmStepFailure(step: .stop)
        }
        if case .running = commandRuns[containerId] {
            // A killed command didn't exit on its own, so its waits find the
            // VM deleting and fail as an unknown VM.
            resolveCommandRun(of: containerId, with: .failure(VmManagerError.unknownVm(containerId: containerId)))
        }
        return nil
    }
}
