import Containerization

/// The services vmo creates once at startup and passes to the routes that use
/// them.
struct Services: Sendable {
    /// Creates and deletes the micro VMs that routes do their work in.
    let readerVmLifecycle: ContainerizationReaderVmLifecycle
}

/// Creates vmo's services, runs `body` with them, and closes them when `body`
/// ends.
///
/// This is vmo's composition root: the only place that creates services and
/// the only owner of their lifetime. The services are closed whether `body`
/// returns or throws. Cancellation ends `body` as `body` allows, and doesn't
/// stop the closing.
///
/// - Parameters:
///   - isolation: Actor that `createContainerManager` and `body` run on: the
///     caller's, by default.
///   - createContainerManager: Creates the container manager the reader VM
///     lifecycle uses. Defaults to ``createProductionContainerManager()``;
///     tests pass one that needs no image or vmnet.
///   - body: Work that uses the services, such as serving HTTP. It must not
///     keep them after it returns.
/// - Throws: The error of `createContainerManager`, before `body` runs. The
///   error `body` throws. ``VmCleanupError`` when closing fails. A
///   ``CleanupAfterFailureError`` with both errors when `body` and closing
///   both fail.
func withServices(
    isolation _: isolated (any Actor)? = #isolation,
    createContainerManager: () async throws -> ContainerManager = createProductionContainerManager,
    _ body: (Services) async throws -> Void
) async throws {
    let services = Services(
        readerVmLifecycle: ContainerizationReaderVmLifecycle(containerManager: try await createContainerManager())
    )
    var bodyError: (any Error)?
    do {
        try await body(services)
    } catch {
        bodyError = error
    }
    try await closeServices(services, after: bodyError)
}

/// Closes every service once `body` has ended.
///
/// - Parameters:
///   - services: Services that `body` no longer uses.
///   - bodyError: What `body` threw, or `nil` when it returned.
/// - Throws: `bodyError` when closing succeeds. The closing error when `body`
///   returned. A ``CleanupAfterFailureError`` when both failed.
private func closeServices(_ services: Services, after bodyError: (any Error)?) async throws {
    do {
        try await services.readerVmLifecycle.close()
    } catch {
        guard let bodyError else {
            throw error
        }
        throw CleanupAfterFailureError(operationError: bodyError, cleanupError: error)
    }
    if let bodyError {
        throw bodyError
    }
}
