import Foundation
import Testing
@testable import vmo

/// Container id of a VM that no lifecycle here created.
private let unknownVmId = ContainerId(text: "missing")

/// Checks the part of ``ContainerizationReaderVmLifecycle`` that only it
/// has, closing, without a VM. ``ReaderVmLifecycleContractTests`` checks it,
/// like every ``ReaderVmLifecycle``, against the parts of that contract that
/// hold without a VM.
///
/// In a test, creating and booting a VM needs an image, a Linux kernel, which
/// vmo finds only on one developer's Mac until #200, and a process signed
/// with the virtualization entitlement, which `swift test` doesn't give, so
/// no test here creates one.
@Suite("Containerization reader VM lifecycle")
struct ContainerizationReaderVmLifecycleTests {
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
        let lifecycle = ContainerizationReaderVmLifecycle(containerManager: try containerRoot.createContainerManager())

        try await lifecycle.close()

        await #expect(throws: ReaderVmLifecycleError.closed) {
            try await lifecycle.createVm(imageReference: readPageImageReference, arguments: ["https://example.com/"])
        }
        await #expect(throws: ReaderVmLifecycleError.closed) {
            try await lifecycle.startVm(containerId: unknownVmId)
        }
        await #expect(throws: ReaderVmLifecycleError.closed) {
            try await lifecycle.waitForCommandExit(containerId: unknownVmId)
        }
        await #expect(throws: ReaderVmLifecycleError.closed) {
            try await lifecycle.deleteVm(containerId: unknownVmId)
        }
    }

    /// Verifies that closing again observes the first cleanup's success.
    @Test("Closing again after close succeeds")
    func closesRepeatedly() async throws {
        let lifecycle = ContainerizationReaderVmLifecycle(containerManager: try containerRoot.createContainerManager())

        try await lifecycle.close()
        try await lifecycle.close()

        await #expect(throws: ReaderVmLifecycleError.closed) {
            try await lifecycle.deleteVm(containerId: unknownVmId)
        }
    }

    /// Verifies that overlapping close calls share one successful cleanup.
    @Test("Concurrent close calls all succeed and leave the lifecycle closed")
    func closesConcurrently() async throws {
        let lifecycle = ContainerizationReaderVmLifecycle(containerManager: try containerRoot.createContainerManager())

        async let firstClose: Void = lifecycle.close()
        async let secondClose: Void = lifecycle.close()
        _ = try await (firstClose, secondClose)

        await #expect(throws: ReaderVmLifecycleError.closed) {
            try await lifecycle.deleteVm(containerId: unknownVmId)
        }
    }
}
