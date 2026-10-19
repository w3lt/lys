import Foundation
import Testing
@testable import vmo

/// Checks the parts of the VM manager's lifecycle that only it has, closing,
/// without a VM. ``ReaderVmLifecycleContractTests`` checks it, like every
/// ``ReaderVmLifecycle``, against the parts of that contract that hold
/// without a VM.
///
/// In a test, creating and booting a VM needs an image, a Linux kernel, which
/// vmo finds only on one developer's Mac until #200, and a process signed
/// with the virtualization entitlement, which `swift test` doesn't give, so
/// no test here creates one.
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

    /// Verifies that closing stops admission before any VM work starts.
    @Test("After close, creating, starting, waiting for, and deleting VMs fail as closed")
    func rejectsOperationsAfterClose() async throws {
        let vmManager = VmManager(containerManager: try containerRoot.createContainerManager())

        try await vmManager.close()

        await #expect(throws: VmManagerError.closed) {
            try await vmManager.createVm(imageReference: readPageImageReference, arguments: ["https://example.com/"])
        }
        await #expect(throws: VmManagerError.closed) {
            try await vmManager.startVm(containerId: "missing")
        }
        await #expect(throws: VmManagerError.closed) {
            try await vmManager.waitForCommandExit(containerId: "missing")
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
