import Foundation

/// Image of the VMs that read pages, built from `sandboxes/readpage`.
///
/// Its entrypoint takes the page's URL as its only argument and accepts only
/// URLs that start with `http://` or `https://`. It loads the page in
/// headless Chromium, removes scripts, styles, and `class` and `style`
/// attributes, and writes the remaining HTML to standard output. When it
/// can't, it exits with a non-zero code and writes the reason to standard
/// error.
///
/// The reference is pinned by digest because a tag can move: it is the image
/// tagged `sha-8fb8b94f84b185f9504a7c38945d05c75bcd6ca7`, built from commit
/// 8fb8b94. vmo pulls it at startup. Reading pages with a newer image means
/// changing this digest.
let readPageImageReference =
    "ghcr.io/w3lt/lys-readpage@sha256:2276b9af21c8467b608025897552601d22f361cdf880efeba97cb675a4fda13c"

/// How reading a page in a VM ended.
enum ReadPageOutcome {
    /// The reader exited before the deadline: this is what it wrote and its
    /// exit code.
    case readerExited(CommandOutput)
    /// The deadline passed first. The VM was deleted, which killed the reader
    /// when it was running.
    case timedOut
}

/// Reads the page at `url` in a VM of its own, which is deleted before this
/// returns or throws.
///
/// The VM runs ``readPageImageReference`` with the text of `url` as its
/// argument. `deadline` covers the whole read, but only the reader's run can
/// be cut short: when the deadline passes, deleting the VM kills the reader.
/// Creating and booting the VM aren't interrupted; when they end after the
/// deadline, the VM is deleted at once.
///
/// Cancelling the caller cancels the creation as far as Containerization
/// observes cancellation, and deletes a VM already created. The deletion
/// itself isn't cancelled, because an interrupted stop could leave the reader
/// running. When stopping the VM fails, the reader may run on, and this
/// returns only when it exits.
///
/// - Parameters:
///   - url: The page to read.
///   - vmManager: Creates and deletes the VM.
///   - deadline: When the read must end.
/// - Returns: How the read ended.
/// - Throws: The errors of ``VmManager`` when the VM can't be created,
///   started, waited for, or deleted; `CancellationError` when the caller was
///   cancelled. A ``CleanupAfterFailureError`` when deleting the VM failed
///   after another failure. When deleting fails, ``VmManager/close()`` tries
///   again.
func readPageInVm(
    _ url: PageUrl,
    _ vmManager: VmManager,
    deadline: ContinuousClock.Instant
) async throws -> ReadPageOutcome {
    let containerId = try await vmManager.createVm(
        imageReference: readPageImageReference,
        arguments: [url.text]
    )
    guard ContinuousClock.now < deadline else {
        try await deleteReaderVm(containerId, vmManager)
        return .timedOut
    }
    do {
        try await vmManager.startVm(containerId: containerId)
    } catch {
        throw await deleteReaderVm(containerId, vmManager, after: error)
    }
    return try await withThrowingTaskGroup(of: CommandOutput?.self) { group in
        group.addTask { try await vmManager.waitForCommandExit(containerId: containerId) }
        let firstEnd = await waitForReaderOrDeadline(in: &group, deadline: deadline)
        return try await deleteReaderVm(containerId, vmManager, endingWith: firstEnd)
    }
}

/// Adds a timer that ends at `deadline` to `group`, which holds the wait for
/// the reader to exit, and waits for the first of the two to end.
///
/// Both are then cancelled. The timer ends at once; the wait doesn't observe
/// cancellation and ends only when the reader exits or its VM is deleted.
///
/// - Parameters:
///   - group: Task group holding only the wait for the reader to exit.
///   - deadline: When the read must end.
/// - Returns: The reader's output when it exited first; `nil` when the
///   deadline passed first; `CancellationError` when the caller was cancelled
///   first; or the wait's error.
private func waitForReaderOrDeadline(
    in group: inout ThrowingTaskGroup<CommandOutput?, any Error>,
    deadline: ContinuousClock.Instant
) async -> Result<CommandOutput?, any Error> {
    group.addTask {
        try await Task.sleep(until: deadline, clock: .continuous)
        return nil
    }
    // The group holds the wait and the timer, so it always has a first end.
    let firstEnd = await group.nextResult() ?? .success(nil)
    group.cancelAll()
    return firstEnd
}

/// Deletes the reader VM once the read has ended, which kills the reader when
/// it hasn't exited, and returns how the read ended.
///
/// - Parameters:
///   - containerId: Container id of the started reader VM.
///   - vmManager: Manager that created the VM.
///   - firstEnd: What ended the read, as
///     `waitForReaderOrDeadline(in:deadline:)` returns it.
/// - Returns: ``ReadPageOutcome/readerExited(_:)`` when the reader exited
///   first; ``ReadPageOutcome/timedOut`` when the deadline passed first.
/// - Throws: The error of `firstEnd`, the deletion error, or a
///   ``CleanupAfterFailureError`` with both.
private func deleteReaderVm(
    _ containerId: String,
    _ vmManager: VmManager,
    endingWith firstEnd: Result<CommandOutput?, any Error>
) async throws -> ReadPageOutcome {
    switch firstEnd {
    case .success(let output):
        try await deleteReaderVm(containerId, vmManager)
        return output.map(ReadPageOutcome.readerExited) ?? .timedOut
    case .failure(let error):
        throw await deleteReaderVm(containerId, vmManager, after: error)
    }
}

/// Deletes the reader VM after the read failed, and returns the error to
/// throw.
///
/// - Parameters:
///   - containerId: Container id of the reader VM.
///   - vmManager: Manager that created the VM.
///   - error: Why the read failed.
/// - Returns: `error` when the VM was deleted; a ``CleanupAfterFailureError``
///   with `error` and the deletion error when deleting failed too.
private func deleteReaderVm(
    _ containerId: String,
    _ vmManager: VmManager,
    after error: any Error
) async -> any Error {
    do {
        try await deleteReaderVm(containerId, vmManager)
    } catch let cleanupError {
        return CleanupAfterFailureError(operationError: error, cleanupError: cleanupError)
    }
    return error
}

/// Deletes the reader VM, stopping it first when it was started.
///
/// The deletion runs in a task of its own, so cancelling the read doesn't
/// interrupt it; this waits for it either way.
///
/// - Parameters:
///   - containerId: Container id of a reader VM that isn't starting.
///   - vmManager: Manager that created the VM.
/// - Throws: The errors of ``VmManager/deleteVm(containerId:)``.
private func deleteReaderVm(_ containerId: String, _ vmManager: VmManager) async throws {
    try await Task { try await vmManager.deleteVm(containerId: containerId) }.value
}
