import Containerization
import Foundation

/// Image every VM runs.
private let imageReference = "docker.io/library/alpine:3.24.2"

/// Failures of ``VmManager`` that come from its own state rather than from
/// the VM work.
enum VmManagerError: Error, Equatable {
    /// ``VmManager/close()`` has begun, so the manager accepts no new
    /// operation.
    case closed
    /// No active VM has this id: the manager didn't create it, or it was
    /// already deleted.
    case unknownVm(containerId: String)
}

/// VMs that ``VmManager/close()`` could not delete.
struct VmCleanupError: Error {
    /// Why each VM could not be deleted, keyed by container id. Its files and
    /// IP address may remain.
    let failures: [String: any Error]
}

/// Owns the micro VMs it creates to give each caller a VM of its own, while
/// guaranteeing that ``close()`` deletes every VM that is still active.
///
/// Invariant: `activeVmIds` holds exactly the VMs this manager created, fully
/// or partly, whose deletion hasn't succeeded. `vmCreations` holds the VMs
/// still being created.
///
/// Resources: the VMs are owned. The container manager is a value that the
/// composition root passes in; its image store and network need no explicit
/// release.
///
/// Lifecycle: ready → closing → closed. ``createVm()`` and
/// ``deleteVm(containerId:)`` work only while ready. Once ``close()`` begins,
/// they throw ``VmManagerError/closed`` before touching any VM. A failed
/// cleanup still ends closed.
///
/// Concurrency model: concurrent. The actor runs one state change at a time.
/// ``createVm()`` suspends while its VM is created, so creations overlap one
/// another, ``deleteVm(containerId:)``, and ``close()``. Deletion is
/// synchronous, so it never overlaps another operation.
actor VmManager {
    /// Where the manager is in its lifecycle.
    private enum Lifecycle {
        /// Operations are accepted.
        case ready
        /// Operations are rejected; `cleanup` waits for creations in progress
        /// and deletes the active VMs.
        case closing(cleanup: Task<Void, any Error>)
        /// Operations are rejected; `cleanup` has ended, and its outcome is
        /// what repeated ``close()`` calls observe.
        case closed(cleanup: Task<Void, any Error>)
    }

    /// Creates and deletes the VMs. Every call works on a copy; the copies
    /// share one network, so their address records stay consistent.
    private let containerManager: ContainerManager
    /// Container ids of the VMs created, fully or partly, and not yet
    /// deleted.
    private var activeVmIds: Set<String> = []
    /// VMs being created, and the cleanup waiting for them.
    private var vmCreations = VmCreations()
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

    /// Creates a VM that stays until ``deleteVm(containerId:)`` or
    /// ``close()`` deletes it.
    ///
    /// The VM gets 2 CPUs, 521 MiB of memory, and a 1 GiB root filesystem from
    /// the Alpine Linux image, which is pulled when the image store doesn't
    /// have it. Its process is `/bin/sh`. The VM is not started.
    ///
    /// Cancelling the caller cancels the creation as far as Containerization
    /// observes cancellation.
    ///
    /// - Returns: The new VM's container id.
    /// - Throws: ``VmManagerError/closed`` when ``close()`` has begun, before
    ///   anything is created, or when it began while this VM was being
    ///   created; ``close()`` then deletes the VM. Containerization's error
    ///   when creation fails, after deleting whatever the creation left. A
    ///   ``CleanupAfterFailureError`` when that deletion fails too; the VM
    ///   then stays active, so ``close()`` tries again.
    func createVm() async throws -> String {
        guard isReady else {
            throw VmManagerError.closed
        }
        let containerId = UUID().uuidString
        vmCreations.add(containerId)
        defer { vmCreations.remove(containerId) }
        var manager = containerManager
        do {
            _ = try await manager.create(containerId, reference: imageReference, rootfsSizeInBytes: 1.gib()) {
                @Sendable config in
                config.cpus = 2
                config.memoryInBytes = 521.mib()
                config.process.arguments = ["/bin/sh"]
                config.process.workingDirectory = "/"
            }
        } catch {
            throw deleteFailedVm(containerId, creationError: error)
        }
        activeVmIds.insert(containerId)
        guard isReady else {
            throw VmManagerError.closed
        }
        return containerId
    }

    /// Deletes an active VM: its files and its IP address.
    ///
    /// - Parameter containerId: Container id that ``createVm()`` returned.
    /// - Throws: ``VmManagerError/closed`` when ``close()`` has begun, which
    ///   deletes the VM instead. ``VmManagerError/unknownVm(containerId:)``
    ///   when no active VM has this id. Containerization's error when
    ///   deletion fails; the VM then stays active, so a later call or
    ///   ``close()`` can try again.
    func deleteVm(containerId: String) throws {
        guard isReady else {
            throw VmManagerError.closed
        }
        guard activeVmIds.contains(containerId) else {
            throw VmManagerError.unknownVm(containerId: containerId)
        }
        try deleteActiveVm(containerId)
    }

    /// Closes the manager: it stops accepting operations, waits for the VMs
    /// being created, and deletes every active VM.
    ///
    /// Repeated and concurrent calls join the first call's cleanup and observe
    /// its outcome. Creations in progress are not cancelled; the cleanup waits
    /// for them to end. Cancelling a caller doesn't stop or shorten the
    /// cleanup, and the call still returns only when the cleanup has ended.
    ///
    /// - Throws: ``VmCleanupError`` listing the VMs that could not be deleted.
    ///   The manager is closed either way.
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

    /// Waits for every creation in progress, then deletes every active VM.
    ///
    /// The VMs don't depend on one another, so their deletion order doesn't
    /// matter; every deletion is attempted even after one fails.
    ///
    /// - Throws: ``VmCleanupError`` with each deletion that failed.
    private func deleteAllVms() async throws {
        await waitForVmCreations()
        var failures: [String: any Error] = [:]
        for containerId in activeVmIds {
            do {
                try deleteActiveVm(containerId)
            } catch {
                failures[containerId] = error
            }
        }
        guard failures.isEmpty else {
            throw VmCleanupError(failures: failures)
        }
    }

    /// Suspends until no VM is being created.
    ///
    /// It doesn't end on cancellation: the cleanup must not delete VMs while a
    /// creation can still add one.
    private func waitForVmCreations() async {
        guard !vmCreations.isEmpty else {
            return
        }
        await withCheckedContinuation { continuation in
            vmCreations.registerEndWaiter(continuation)
        }
    }

    /// Deletes an active VM and stops tracking it.
    ///
    /// - Parameter containerId: Container id of an active VM.
    /// - Throws: Containerization's error when deletion fails; the VM then
    ///   stays active.
    private func deleteActiveVm(_ containerId: String) throws {
        var manager = containerManager
        try manager.delete(containerId)
        activeVmIds.remove(containerId)
    }

    /// Deletes what a failed creation left: the VM's directory and its IP
    /// address.
    ///
    /// - Parameters:
    ///   - containerId: Container id of the VM whose creation failed.
    ///   - creationError: Why the creation failed.
    /// - Returns: The error for ``createVm()`` to throw: `creationError` when
    ///   nothing is left, or a ``CleanupAfterFailureError`` when deletion
    ///   fails, after which the VM is active so ``close()`` tries again.
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
            activeVmIds.insert(containerId)
            return CleanupAfterFailureError(operationError: creationError, cleanupError: error)
        }
        return creationError
    }
}

/// The VMs being created, and the cleanup waiting for those creations to end.
///
/// One value, because the waiter must be resumed exactly when the last
/// creation ends.
private struct VmCreations {
    /// Container ids of the VMs being created.
    private var containerIds: Set<String> = []
    /// Cleanup suspended until `containerIds` is empty. It is set only while
    /// `containerIds` isn't empty.
    private var endWaiter: CheckedContinuation<Void, Never>?

    /// Whether no VM is being created.
    var isEmpty: Bool {
        containerIds.isEmpty
    }

    /// Adds a VM whose creation has begun.
    ///
    /// - Parameter containerId: Container id of that VM.
    mutating func add(_ containerId: String) {
        containerIds.insert(containerId)
    }

    /// Removes a VM whose creation has ended, and resumes the waiter when it
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

    /// Registers the cleanup to resume when the last creation ends.
    ///
    /// - Parameter waiter: The suspended cleanup.
    /// - Precondition: A creation is in progress and no waiter is registered.
    ///   Only the manager's one cleanup task waits.
    mutating func registerEndWaiter(_ waiter: CheckedContinuation<Void, Never>) {
        precondition(!containerIds.isEmpty && endWaiter == nil, "VmCreations accepts one waiter while creations run")
        endWaiter = waiter
    }
}
