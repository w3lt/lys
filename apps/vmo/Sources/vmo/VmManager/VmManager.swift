import Containerization
import Foundation

/// Failures of ``VmManager`` that come from its own state rather than from
/// the VM work.
enum VmManagerError: Error, Equatable {
    /// ``VmManager/close()`` has begun, so the manager accepts no new
    /// operation.
    case closed
    /// No VM with this id is available: the manager didn't create it, or its
    /// deletion has begun.
    case unknownVm(containerId: String)
    /// ``VmManager/startVm(containerId:)`` was already called for this VM. A
    /// VM starts at most once, even when its start failed.
    case alreadyStarted(containerId: String)
    /// The VM's command hasn't started: ``VmManager/startVm(containerId:)``
    /// wasn't called for it, is still starting it, or failed.
    case notStarted(containerId: String)
    /// ``VmManager/startVm(containerId:)`` is starting this VM, so it can't be
    /// deleted until that start ends.
    case startInProgress(containerId: String)
}

/// VMs that ``VmManager/close()`` could not stop or delete.
struct VmCleanupError: Error {
    /// Why each VM could not be stopped or deleted, keyed by container id. A
    /// VM whose deletion failed may leave its files and IP address; one whose
    /// stop failed may run until vmo exits.
    let failures: [String: any Error]
}

/// Owns the micro VMs it creates to give each caller a VM of its own that
/// runs one command, while guaranteeing that ``close()`` deletes every VM
/// that is still active.
///
/// Invariant: `activeVms` holds exactly the VMs this manager created, fully
/// or partly, whose deletion hasn't succeeded, each in the phase it has
/// reached. `vmOperations` holds the VMs being created, started, or deleted.
///
/// A VM's phases: created → starting → started, or startFailed when the
/// start fails. A VM starts at most once. Deletion moves a VM in any phase
/// but starting to deleting. The VM leaves `activeVms` when its deletion
/// succeeds, and stays deleting for ``close()`` to try again when it fails.
///
/// Resources: the VMs are owned, and so is each started VM's wait for its
/// command to exit. The container manager is a value that the composition
/// root passes in; its image store and network need no explicit release.
///
/// Lifecycle: ready → closing → closed. Every operation but ``close()``
/// works only while ready. Once ``close()`` begins, they throw
/// ``VmManagerError/closed`` before touching any VM. A failed cleanup still
/// ends closed.
///
/// Concurrency model: concurrent. The actor runs one state change at a time.
/// Creating, starting, and deleting a VM suspend while Containerization
/// works, so they overlap one another, waits, and ``close()``. Each operation
/// records its VM's new phase before it suspends, so an overlapping operation
/// on the same VM fails with a ``VmManagerError`` instead of interleaving.
/// ``waitForCommandExit(containerId:)`` suspends until the command exits
/// without holding up other operations.
actor VmManager: ReaderVmLifecycle {
    /// Where the manager is in its lifecycle.
    private enum Lifecycle {
        /// Operations are accepted.
        case ready
        /// Operations are rejected; `cleanup` waits for the VM operations in
        /// progress and deletes the active VMs.
        case closing(cleanup: Task<Void, any Error>)
        /// Operations are rejected; `cleanup` has ended, and its outcome is
        /// what repeated ``close()`` calls observe.
        case closed(cleanup: Task<Void, any Error>)
    }

    /// Creates and deletes the VMs. Every call works on a copy; the copies
    /// share one network, so their address records stay consistent.
    private let containerManager: ContainerManager
    /// The VMs created, fully or partly, and not yet deleted, keyed by
    /// container id.
    private var activeVms: [String: ActiveVm] = [:]
    /// VMs being created, started, or deleted, and the cleanup waiting for
    /// those operations to end.
    private var vmOperations = VmOperations()
    /// Where the manager is in its lifecycle.
    private var lifecycle = Lifecycle.ready

    /// Creates a manager with no VMs, ready for use.
    ///
    /// - Parameter containerManager: Creates and deletes the VMs. Its network
    ///   must be a ``SharedNetwork`` or none, because the manager works on
    ///   copies of it.
    init(containerManager: ContainerManager) {
        self.containerManager = containerManager
    }

    /// Whether the manager accepts operations, because ``close()`` hasn't
    /// begun.
    private var isReady: Bool {
        if case .ready = lifecycle {
            return true
        }
        return false
    }

    /// Implements ``ReaderVmLifecycle/createVm(imageReference:arguments:)``
    /// with a micro VM, which stays until ``deleteVm(containerId:)`` or
    /// ``close()`` deletes it.
    ///
    /// The VM gets 2 CPUs, 512 MiB of memory, and a 1 GiB root filesystem
    /// unpacked from the image, which is pulled when the image store doesn't
    /// have it. Its command runs with the image's working directory,
    /// environment, and user. Containerization decides how far the creation
    /// observes cancellation.
    ///
    /// - Parameters:
    ///   - imageReference: Reference of the image to run, such as
    ///     `docker.io/library/alpine:3.24.2`.
    ///   - arguments: Arguments added after the image's entrypoint and
    ///     command. The VM rejects an empty command when it starts.
    /// - Returns: The new VM's container id, a fresh UUID.
    /// - Throws: The errors of the protocol operation, with Containerization's
    ///   error as the mechanism's. ``VmManagerError/closed`` when ``close()``
    ///   has begun, before anything is created, or when it began while this VM
    ///   was being created; ``close()`` then deletes the VM. When deleting
    ///   what a failed creation left fails, the VM stays active, so
    ///   ``close()`` tries again.
    func createVm(imageReference: String, arguments: [String]) async throws -> String {
        guard isReady else {
            throw VmManagerError.closed
        }
        let containerId = UUID().uuidString
        vmOperations.add(containerId)
        defer { vmOperations.remove(containerId) }
        let buffers = CommandOutputBuffers()
        var manager = containerManager
        let container: LinuxContainer
        do {
            container = try await manager.create(containerId, reference: imageReference, rootfsSizeInBytes: 1.gib()) {
                @Sendable config in
                configureVm(&config, arguments: arguments, buffers: buffers)
            }
            // Containerization may finish creating after the caller was
            // cancelled, and that caller won't delete a VM it never gets.
            try Task.checkCancellation()
        } catch {
            throw deleteFailedVm(containerId, creationError: error)
        }
        activeVms[containerId] = .created(container, buffers: buffers)
        guard isReady else {
            throw VmManagerError.closed
        }
        return containerId
    }

    /// Implements ``ReaderVmLifecycle/startVm(containerId:)`` by booting the
    /// micro VM and starting its command in it.
    ///
    /// What the command writes is kept for
    /// ``waitForCommandExit(containerId:)``.
    ///
    /// - Parameter containerId: Container id that
    ///   ``createVm(imageReference:arguments:)`` returned.
    /// - Throws: The errors of the protocol operation, with Containerization's
    ///   error as the mechanism's; Containerization has then stopped the VM.
    ///   ``VmManagerError/closed`` when ``close()`` has begun, before anything
    ///   is started, or when it began while this VM was starting; ``close()``
    ///   then stops and deletes the VM.
    func startVm(containerId: String) async throws {
        let vm = try activeVm(containerId)
        let (container, buffers) =
            switch vm {
            case .created(let container, let buffers): (container, buffers)
            case .starting, .started, .startFailed: throw VmManagerError.alreadyStarted(containerId: containerId)
            case .deleting: throw VmManagerError.unknownVm(containerId: containerId)
            }
        activeVms[containerId] = .starting
        vmOperations.add(containerId)
        defer { vmOperations.remove(containerId) }
        do {
            try await container.create()
            try await container.start()
        } catch {
            activeVms[containerId] = .startFailed
            throw error
        }
        let commandExit = Task {
            let exitStatus = try await container.wait()
            return buffers.output(exitCode: exitStatus.exitCode)
        }
        activeVms[containerId] = .started(container, commandExit: commandExit)
        guard isReady else {
            throw VmManagerError.closed
        }
    }

    /// Implements ``ReaderVmLifecycle/waitForCommandExit(containerId:)`` for
    /// a micro VM's command.
    ///
    /// After the command exits, Containerization 0.52.0 waits at most 3
    /// seconds for its output to arrive; output arriving later is not
    /// included. Closing the manager ends the wait, as deleting the VM does.
    ///
    /// - Parameter containerId: Container id of a VM that
    ///   ``startVm(containerId:)`` started.
    /// - Returns: The command's output and exit code, as the protocol
    ///   operation returns them.
    /// - Throws: The errors of the protocol operation, with Containerization's
    ///   error as the mechanism's. ``VmManagerError/closed`` when ``close()``
    ///   has begun, before or during the wait.
    func waitForCommandExit(containerId: String) async throws -> CommandOutput {
        let output = try await commandExit(of: containerId).result
        // Deleting the VM or closing the manager stops the command, which
        // then exits because it was killed, not on its own.
        _ = try commandExit(of: containerId)
        return try output.get()
    }

    /// Implements ``ReaderVmLifecycle/deleteVm(containerId:)`` for a micro VM,
    /// whose address is an IP address.
    ///
    /// A failed stop can't be retried, because Containerization then keeps
    /// throwing its error, so the files and IP address are deleted even then.
    /// A VM whose stop failed may run until vmo exits. A VM whose deletion
    /// failed stays active and unavailable, so ``close()`` tries again.
    ///
    /// - Parameter containerId: Container id that
    ///   ``createVm(imageReference:arguments:)`` returned.
    /// - Throws: The errors of the protocol operation, with Containerization's
    ///   stop and delete errors as the mechanism's. ``VmManagerError/closed``
    ///   when ``close()`` has begun, which deletes the VM instead.
    func deleteVm(containerId: String) async throws {
        switch try activeVm(containerId) {
        case .created, .started, .startFailed: try await deleteActiveVm(containerId)
        case .starting: throw VmManagerError.startInProgress(containerId: containerId)
        case .deleting: throw VmManagerError.unknownVm(containerId: containerId)
        }
    }

    /// Closes the manager: it stops accepting operations, waits for the VMs
    /// being created, started, or deleted, then stops and deletes every
    /// active VM.
    ///
    /// Repeated and concurrent calls join the first call's cleanup and observe
    /// its outcome. Operations in progress are not cancelled; the cleanup
    /// waits for them to end. Waits for a command's exit end when the cleanup
    /// stops their VM. Cancelling a caller doesn't stop or shorten the
    /// cleanup, and the call still returns only when the cleanup has ended.
    ///
    /// - Throws: ``VmCleanupError`` listing the VMs that could not be stopped
    ///   or deleted. The manager is closed either way.
    func close() async throws {
        let cleanup = startCleanup()
        // Awaiting a task's value doesn't end early when the caller is
        // cancelled, so the cleanup has always ended when this runs.
        defer { lifecycle = .closed(cleanup: cleanup) }
        try await cleanup.value
    }

    /// Returns the manager's cleanup, starting it when the manager is ready.
    ///
    /// The cleanup runs in its own task, so it doesn't inherit any caller's
    /// cancellation.
    ///
    /// - Returns: The cleanup in progress or already ended.
    private func startCleanup() -> Task<Void, any Error> {
        switch lifecycle {
        case .ready:
            let cleanup = Task { try await self.deleteAllVms() }
            lifecycle = .closing(cleanup: cleanup)
            return cleanup
        case .closing(let cleanup), .closed(let cleanup):
            return cleanup
        }
    }

    /// Waits for every VM operation in progress, then deletes every active
    /// VM.
    ///
    /// The VMs don't depend on one another, so their deletion order doesn't
    /// matter; every deletion is attempted even after one fails.
    ///
    /// - Throws: ``VmCleanupError`` with each deletion that failed.
    private func deleteAllVms() async throws {
        await waitForVmOperations()
        var failures: [String: any Error] = [:]
        for containerId in activeVms.keys {
            do {
                try await deleteActiveVm(containerId)
            } catch {
                failures[containerId] = error
            }
        }
        guard failures.isEmpty else {
            throw VmCleanupError(failures: failures)
        }
    }

    /// Suspends until no VM is being created, started, or deleted.
    ///
    /// It doesn't end on cancellation: the cleanup must not delete VMs while
    /// another operation can still change them.
    private func waitForVmOperations() async {
        guard !vmOperations.isEmpty else {
            return
        }
        await withCheckedContinuation { continuation in
            vmOperations.registerEndWaiter(continuation)
        }
    }

    /// Returns an active VM, while the manager accepts operations.
    ///
    /// - Parameter containerId: Container id of the VM.
    /// - Returns: The VM in its current phase.
    /// - Throws: ``VmManagerError/closed`` when ``close()`` has begun.
    ///   ``VmManagerError/unknownVm(containerId:)`` when the manager has no
    ///   such VM.
    private func activeVm(_ containerId: String) throws -> ActiveVm {
        guard isReady else {
            throw VmManagerError.closed
        }
        guard let vm = activeVms[containerId] else {
            throw VmManagerError.unknownVm(containerId: containerId)
        }
        return vm
    }

    /// Returns the wait for a started VM's command to exit.
    ///
    /// - Parameter containerId: Container id of the VM.
    /// - Returns: The task that ends when the command exits.
    /// - Throws: The errors of ``waitForCommandExit(containerId:)`` other than
    ///   Containerization's.
    private func commandExit(of containerId: String) throws -> Task<CommandOutput, any Error> {
        let vm = try activeVm(containerId)
        return switch vm {
        case .started(_, let commandExit): commandExit
        case .created, .starting, .startFailed: throw VmManagerError.notStarted(containerId: containerId)
        case .deleting: throw VmManagerError.unknownVm(containerId: containerId)
        }
    }

    /// Stops an active VM when its command was started, then deletes its
    /// files and IP address and stops tracking it.
    ///
    /// - Parameter containerId: Container id of an active VM that isn't
    ///   starting.
    /// - Throws: The errors of ``deleteVm(containerId:)`` that come from
    ///   Containerization. When deleting fails, the VM stays deleting.
    private func deleteActiveVm(_ containerId: String) async throws {
        let vm = activeVms[containerId]
        activeVms[containerId] = .deleting
        vmOperations.add(containerId)
        defer { vmOperations.remove(containerId) }
        var stopError: (any Error)?
        if case .started(let container, let commandExit) = vm {
            do {
                try await container.stop()
                // The stop ends the wait; its result is discarded with the VM.
                _ = await commandExit.result
            } catch {
                stopError = error
            }
        }
        var manager = containerManager
        do {
            try manager.delete(containerId)
        } catch {
            guard let stopError else {
                throw error
            }
            throw CleanupAfterFailureError(operationError: stopError, cleanupError: error)
        }
        activeVms[containerId] = nil
        if let stopError {
            throw stopError
        }
    }

    /// Deletes what a failed creation left: the VM's directory and its IP
    /// address.
    ///
    /// - Parameters:
    ///   - containerId: Container id of the VM whose creation failed.
    ///   - creationError: Why the creation failed, such as a
    ///     `CancellationError` when the caller was cancelled.
    /// - Returns: The error for ``createVm(imageReference:arguments:)`` to
    ///   throw: `creationError` when nothing is left, or a
    ///   ``CleanupAfterFailureError`` when deletion fails, after which the VM
    ///   stays deleting so ``close()`` tries again.
    private func deleteFailedVm(_ containerId: String, creationError: any Error) -> any Error {
        var manager = containerManager
        do {
            try manager.delete(containerId)
        } catch let error as CocoaError where error.code == .fileNoSuchFile {
            // The creation failed before making the VM's directory. In
            // Containerization 0.52.0, `delete` releases the IP address before
            // it removes the directory, so nothing is left.
            return creationError
        } catch {
            activeVms[containerId] = .deleting
            return CleanupAfterFailureError(operationError: creationError, cleanupError: error)
        }
        return creationError
    }
}

/// Sets up a new VM's size and its command, whose output goes to `buffers`.
///
/// - Parameters:
///   - config: The VM's configuration, prefilled from the image: its command
///     is the image's entrypoint and command, with the image's working
///     directory, environment, and user.
///   - arguments: Arguments added after the image's entrypoint and command.
///   - buffers: Where the command's standard output and standard error go.
private func configureVm(
    _ config: inout LinuxContainer.Configuration,
    arguments: [String],
    buffers: CommandOutputBuffers
) {
    config.cpus = 2
    config.memoryInBytes = 512.mib()
    config.process.arguments += arguments
    config.process.stdout = buffers.stdout
    config.process.stderr = buffers.stderr
}

/// A VM the manager created, fully or partly, and hasn't deleted, in the
/// phase it has reached. Each phase holds only what the next operations on
/// the VM need.
private enum ActiveVm {
    /// Created and not booted; ``VmManager/startVm(containerId:)`` may start
    /// it. `buffers` will receive its command's output.
    case created(LinuxContainer, buffers: CommandOutputBuffers)
    /// ``VmManager/startVm(containerId:)`` is booting it and starting its
    /// command.
    case starting
    /// Its command started. `commandExit` ends when the command exits or the
    /// VM stops, with what the command wrote.
    case started(LinuxContainer, commandExit: Task<CommandOutput, any Error>)
    /// Its start failed and Containerization stopped it, so only deleting its
    /// files and IP address remains.
    case startFailed
    /// A deletion is in progress, or failed and left the VM for
    /// ``VmManager/close()`` to try again.
    case deleting
}

/// The VMs being created, started, or deleted, and the cleanup waiting for
/// those operations to end.
///
/// One value, because the waiter must be resumed exactly when the last
/// operation ends.
private struct VmOperations {
    /// Container ids of the VMs with an operation in progress. The manager
    /// runs at most one operation per VM at a time.
    private var containerIds: Set<String> = []
    /// Cleanup suspended until `containerIds` is empty. It is set only while
    /// `containerIds` isn't empty.
    private var endWaiter: CheckedContinuation<Void, Never>?

    /// Whether no VM operation is in progress.
    var isEmpty: Bool {
        containerIds.isEmpty
    }

    /// Adds a VM whose operation has begun.
    ///
    /// - Parameter containerId: Container id of that VM.
    mutating func add(_ containerId: String) {
        containerIds.insert(containerId)
    }

    /// Removes a VM whose operation has ended, and resumes the waiter when it
    /// was the last one.
    ///
    /// - Parameter containerId: Container id of that VM.
    mutating func remove(_ containerId: String) {
        containerIds.remove(containerId)
        guard containerIds.isEmpty, let endWaiter else {
            return
        }
        self.endWaiter = nil
        endWaiter.resume()
    }

    /// Registers the cleanup to resume when the last operation ends.
    ///
    /// - Parameter waiter: The suspended cleanup.
    /// - Precondition: An operation is in progress and no waiter is
    ///   registered. Only the manager's one cleanup task waits.
    mutating func registerEndWaiter(_ waiter: CheckedContinuation<Void, Never>) {
        precondition(!containerIds.isEmpty && endWaiter == nil, "VmOperations accepts one waiter while operations run")
        endWaiter = waiter
    }
}
