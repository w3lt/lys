import Foundation
import Testing
@testable import vmo

/// Checks the parts of the VM manager's lifecycle that run without a VM.
///
/// Creating a VM needs the Alpine image, a Linux kernel, and Virtualization
/// support, so no test here creates one.
@Suite("VM manager lifecycle")
struct VmManagerTests {
    /// Directory holding this test's image store.
    private let containerRoot: TemporaryContainerRoot

    /// Creates this test's container directory.
    ///
    /// - Throws: The file system's error when the directory can't be created.
    init() throws {
        containerRoot = try TemporaryContainerRoot()
    }

    /// Verifies that a ready manager rejects an id it never returned.
    @Test("Deleting a VM the manager didn't create fails as unknown")
    func rejectsUnknownVm() async throws {
        let vmManager = VmManager(containerManager: try containerRoot.createContainerManager())

        await #expect(throws: VmManagerError.unknownVm(containerId: "missing")) {
            try await vmManager.deleteVm(containerId: "missing")
        }
    }

    /// Verifies that closing stops admission before any VM work starts.
    @Test("After close, creating and deleting VMs fail as closed")
    func rejectsOperationsAfterClose() async throws {
        let vmManager = VmManager(containerManager: try containerRoot.createContainerManager())

        try await vmManager.close()

        await #expect(throws: VmManagerError.closed) {
            try await vmManager.createVm()
        }
        await #expect(throws: VmManagerError.closed) {
            try await vmManager.deleteVm(containerId: "missing")
        }
    }

    /// Verifies that closing again observes the first cleanup's success.
    @Test("Closing again after close succeeds")
    func closesRepeatedly() async throws {
        let vmManager = VmManager(containerManager: try containerRoot.createContainerManager())

        try await vmManager.close()
        try await vmManager.close()

        await #expect(throws: VmManagerError.closed) {
            try await vmManager.deleteVm(containerId: "missing")
        }
    }

    /// Verifies that overlapping close calls share one successful cleanup.
    @Test("Concurrent close calls all succeed and leave the manager closed")
    func closesConcurrently() async throws {
        let vmManager = VmManager(containerManager: try containerRoot.createContainerManager())

        async let firstClose: Void = vmManager.close()
        async let secondClose: Void = vmManager.close()
        _ = try await (firstClose, secondClose)

        await #expect(throws: VmManagerError.closed) {
            try await vmManager.deleteVm(containerId: "missing")
        }
    }
}
