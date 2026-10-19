import Containerization
import Testing
@testable import vmo

/// Failure thrown by a `withServices` body in these tests.
private struct BodyError: Error, Equatable {}

/// Failure thrown by a container manager factory in these tests.
private struct ContainerManagerCreationError: Error, Equatable {}

/// Container id of a VM that the services' lifecycle didn't create.
private let unknownVmId = ContainerId(text: "missing")

/// Checks that `withServices` creates the services, passes them to its body,
/// and always closes them.
@Suite("Services lifetime")
struct ServicesTests {
    /// Directory holding this test's image store.
    private let containerRoot: TemporaryContainerRoot

    /// Creates this test's container directory.
    ///
    /// - Throws: The file system's error when the directory can't be created.
    init() throws {
        containerRoot = try TemporaryContainerRoot()
    }

    /// Verifies that the body gets ready services, and that they are closed
    /// once it returns.
    @Test("Passes ready services to the body and closes them after it returns")
    func closesServicesAfterBodyReturns() async throws {
        var bodyServices: Services?

        try await withServices(createContainerManager: containerRoot.createContainerManager) { services in
            await #expect(throws: ReaderVmLifecycleError.unknownVm(containerId: unknownVmId)) {
                try await services.readerVmLifecycle.deleteVm(containerId: unknownVmId)
            }
            bodyServices = services
        }

        let services = try #require(bodyServices)
        await #expect(throws: ReaderVmLifecycleError.closed) {
            try await services.readerVmLifecycle.deleteVm(containerId: unknownVmId)
        }
    }

    /// Verifies that a body failure reaches the caller unchanged and the
    /// services are closed anyway.
    @Test("Throws the body's error and still closes the services")
    func closesServicesAfterBodyThrows() async throws {
        var bodyServices: Services?

        await #expect(throws: BodyError()) {
            try await withServices(createContainerManager: containerRoot.createContainerManager) { services in
                bodyServices = services
                throw BodyError()
            }
        }

        let services = try #require(bodyServices)
        await #expect(throws: ReaderVmLifecycleError.closed) {
            try await services.readerVmLifecycle.deleteVm(containerId: unknownVmId)
        }
    }

    /// Verifies that a creation failure stops startup before the body runs.
    @Test("Throws the container manager's creation error without running the body")
    func skipsBodyWhenCreationFails() async {
        var isBodyRun = false

        await #expect(throws: ContainerManagerCreationError()) {
            try await withServices(createContainerManager: { throw ContainerManagerCreationError() }) { _ in
                isBodyRun = true
            }
        }

        #expect(!isBodyRun)
    }
}
