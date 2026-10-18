/// An operation that failed, followed by a failure of the cleanup it required.
///
/// Both errors are kept so that neither hides the other.
struct CleanupAfterFailureError: Error {
    /// Why the operation failed.
    let operationError: any Error
    /// Why the cleanup after that failure failed.
    let cleanupError: any Error
}
