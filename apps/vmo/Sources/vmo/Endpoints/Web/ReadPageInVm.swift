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
enum ReadPageOutcome: Sendable {
    /// The reader exited before the deadline: this is what it wrote and its
    /// exit code.
    case readerExited(CommandOutput)
    /// The deadline passed first. The VM was deleted, which killed the reader
    /// when it was running.
    case timedOut
}

/// A reader VM lifecycle can take a VM that runs one command through its
/// life: creation, start, the command's exit, and deletion.
///
/// ``readPageInVm(_:_:deadline:)`` reads each page in a VM of its own
/// through it.
///
/// A VM moves from created to started, or to a failed start, and starts at
/// most once. Deletion ends it in any of these phases, but not while it
/// starts. The VM that ``createVm(imageReference:arguments:)`` returns belongs
/// to the caller until ``deleteVm(containerId:)`` deletes it. A VM whose
/// deletion failed is no longer available to the caller; the implementation
/// keeps it for its own cleanup. Once its owner closes an implementation,
/// every operation fails with ``VmManagerError/closed`` before it touches a
/// VM.
///
/// Concurrency model: concurrent. Operations on different VMs overlap, and
/// waits overlap every other operation. An operation that a VM's phase
/// doesn't allow, such as deleting the VM while it starts, fails with a
/// ``VmManagerError`` instead of waiting for the phase to change.
///
/// Every implementation gives the results and the ``VmManagerError`` cases
/// documented here for the same calls. Any other error is a failure of the VM
/// mechanism, thrown unchanged; after one, the caller can only delete the VM.
protocol ReaderVmLifecycle: Sendable {
    /// Creates a VM that will run `imageReference` with `arguments`, without
    /// starting it.
    ///
    /// The VM's command is the image's entrypoint and command followed by
    /// `arguments`. What the command will write to standard output and
    /// standard error is kept, up to ``maximumKeptStreamByteCount`` bytes of
    /// each. Cancelling the caller ends the creation as far as the mechanism
    /// observes cancellation, and a VM created after the caller was cancelled
    /// is deleted, so a cancelled caller never gets a VM.
    ///
    /// - Parameters:
    ///   - imageReference: Reference of the image to run.
    ///   - arguments: Arguments added after the image's entrypoint and
    ///     command.
    /// - Returns: The new VM's container id, which no other VM of this
    ///   lifecycle has had.
    /// - Throws: The mechanism's error when creation fails, or
    ///   `CancellationError` when the caller was cancelled, after deleting
    ///   whatever the creation left. A ``CleanupAfterFailureError`` with both
    ///   errors when that deletion fails too.
    func createVm(imageReference: String, arguments: [String]) async throws -> String

    /// Boots a created VM and starts its command, without waiting for the
    /// command to exit.
    ///
    /// The command then runs until it exits or the VM is deleted. A start that
    /// fails, including one the mechanism ends because the caller was
    /// cancelled, leaves a VM that can only be deleted.
    ///
    /// - Parameter containerId: Container id that
    ///   ``createVm(imageReference:arguments:)`` returned.
    /// - Throws: ``VmManagerError/unknownVm(containerId:)`` when no VM with
    ///   this id is available. ``VmManagerError/alreadyStarted(containerId:)``
    ///   when this VM's start was already called. The mechanism's error when
    ///   booting the VM or starting its command fails.
    func startVm(containerId: String) async throws

    /// Waits until a started VM's command exits, then returns what it wrote,
    /// up to ``maximumKeptStreamByteCount`` bytes of each stream
    /// (``CommandStreamOutput/isTruncated`` says when more was dropped), and
    /// its exit code.
    ///
    /// Concurrent and repeated calls share one wait, so they return the same
    /// output. There is no time limit. Cancelling the caller doesn't end the
    /// wait. Deleting the VM does: at once when the deletion stops the
    /// command, or when the command exits after stopping it failed.
    ///
    /// - Parameter containerId: Container id of a VM that
    ///   ``startVm(containerId:)`` started.
    /// - Returns: The command's output and exit code. A non-zero exit code is
    ///   returned, not thrown.
    /// - Throws: ``VmManagerError/unknownVm(containerId:)`` when no VM with
    ///   this id is available, or when its deletion began during the wait.
    ///   ``VmManagerError/notStarted(containerId:)`` when its command hasn't
    ///   started. The mechanism's error when waiting fails.
    func waitForCommandExit(containerId: String) async throws -> CommandOutput

    /// Deletes a VM: stops it when its command was started, then deletes its
    /// files and address.
    ///
    /// Stopping kills the command and ends every wait for it. When stopping
    /// fails, the files and address are deleted anyway, and the command may
    /// run on until it exits. Cancelling the caller may interrupt the stop as
    /// far as the mechanism observes cancellation, so a caller that must stop
    /// the command deletes from a task that isn't cancelled. Once deleted, the
    /// VM's id names no VM, so a second deletion fails.
    ///
    /// - Parameter containerId: Container id that
    ///   ``createVm(imageReference:arguments:)`` returned.
    /// - Throws: ``VmManagerError/unknownVm(containerId:)`` when no VM with
    ///   this id is available. ``VmManagerError/startInProgress(containerId:)``
    ///   while ``startVm(containerId:)`` starts it. The mechanism's stop error
    ///   when only stopping failed; the VM is deleted anyway. The mechanism's
    ///   delete error when deleting failed, or a ``CleanupAfterFailureError``
    ///   with both errors when stopping failed too; the VM is then no longer
    ///   available.
    func deleteVm(containerId: String) async throws
}

/// When a read must end, on the clock that measures it.
///
/// `DeadlineClock` is that clock's type: vmo reads pages on
/// `ContinuousClock`, and tests on a clock they move themselves.
struct ReadDeadline<DeadlineClock: Clock>: Sendable {
    /// The instant on ``clock`` by which the read must end.
    let instant: DeadlineClock.Instant
    /// The clock the read checks and waits on.
    let clock: DeadlineClock
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
/// Cancelling the caller cancels the creation as far as `vmLifecycle`
/// observes cancellation, and deletes a VM already created. The deletion
/// itself isn't cancelled, because an interrupted stop could leave the reader
/// running. When stopping the VM fails, the reader may run on, and this
/// returns only when it exits.
///
/// - Parameters:
///   - url: The page to read.
///   - vmLifecycle: Creates, starts, waits for, and deletes the VM.
///   - deadline: When the read must end.
/// - Returns: How the read ended.
/// - Throws: The errors of ``ReaderVmLifecycle`` when the VM can't be
///   created, started, waited for, or deleted; `CancellationError` when the
///   caller was cancelled. A ``CleanupAfterFailureError`` when deleting the VM
///   failed after another failure. A VM whose deletion failed is left to
///   `vmLifecycle`'s own cleanup.
func readPageInVm<DeadlineClock: Clock>(
    _ url: PageUrl,
    _ vmLifecycle: some ReaderVmLifecycle,
    deadline: ReadDeadline<DeadlineClock>
) async throws -> ReadPageOutcome {
    let containerId = try await vmLifecycle.createVm(imageReference: readPageImageReference, arguments: [url.text])
    guard deadline.clock.now < deadline.instant else {
        try await deleteReaderVm(containerId, vmLifecycle)
        return .timedOut
    }
    do {
        try await vmLifecycle.startVm(containerId: containerId)
    } catch {
        throw await deleteReaderVmAfterFailure(containerId, vmLifecycle, failure: error)
    }
    return try await withThrowingTaskGroup(of: ReadPageOutcome.self) { group in
        group.addTask { .readerExited(try await vmLifecycle.waitForCommandExit(containerId: containerId)) }
        let firstEnd = await waitForReaderOrDeadline(in: &group, deadline: deadline)
        return try await deleteReaderVmAfterRead(containerId, vmLifecycle, firstEnd: firstEnd)
    }
}

/// Adds a timer that ends at the deadline to `group`, which holds the wait
/// for the reader to exit, and waits for the first of the two to end.
///
/// Both are then cancelled. The timer ends at once; the wait doesn't observe
/// cancellation and ends only when the reader exits or its VM is deleted.
///
/// - Parameters:
///   - group: Task group holding only the wait for the reader to exit.
///   - deadline: When the read must end.
/// - Returns: ``ReadPageOutcome/readerExited(_:)`` when the reader exited
///   first; ``ReadPageOutcome/timedOut`` when the deadline passed first;
///   `CancellationError` when the caller was cancelled first; or the wait's
///   error.
private func waitForReaderOrDeadline<DeadlineClock: Clock>(
    in group: inout ThrowingTaskGroup<ReadPageOutcome, any Error>,
    deadline: ReadDeadline<DeadlineClock>
) async -> Result<ReadPageOutcome, any Error> {
    group.addTask {
        try await Task.sleep(until: deadline.instant, clock: deadline.clock)
        return .timedOut
    }
    guard let firstEnd = await group.nextResult() else {
        preconditionFailure("The read's task group holds the wait and the timer, so one of them ends first")
    }
    group.cancelAll()
    return firstEnd
}

/// Deletes the reader VM once the read has ended, which kills the reader when
/// it hasn't exited, and returns how the read ended.
///
/// - Parameters:
///   - containerId: Container id of the started reader VM.
///   - vmLifecycle: Lifecycle that created the VM.
///   - firstEnd: What ended the read, as
///     `waitForReaderOrDeadline(in:deadline:)` returns it.
/// - Returns: The outcome of `firstEnd`.
/// - Throws: The error of `firstEnd`, the deletion error, or a
///   ``CleanupAfterFailureError`` with both.
private func deleteReaderVmAfterRead(
    _ containerId: String,
    _ vmLifecycle: some ReaderVmLifecycle,
    firstEnd: Result<ReadPageOutcome, any Error>
) async throws -> ReadPageOutcome {
    switch firstEnd {
    case .success(let outcome):
        try await deleteReaderVm(containerId, vmLifecycle)
        return outcome
    case .failure(let error):
        throw await deleteReaderVmAfterFailure(containerId, vmLifecycle, failure: error)
    }
}

/// Deletes the reader VM after the read failed, and returns the error to
/// throw.
///
/// - Parameters:
///   - containerId: Container id of the reader VM.
///   - vmLifecycle: Lifecycle that created the VM.
///   - failure: Why the read failed.
/// - Returns: `failure` when the VM was deleted; a
///   ``CleanupAfterFailureError`` with `failure` and the deletion error when
///   deleting failed too.
private func deleteReaderVmAfterFailure(
    _ containerId: String,
    _ vmLifecycle: some ReaderVmLifecycle,
    failure: any Error
) async -> any Error {
    do {
        try await deleteReaderVm(containerId, vmLifecycle)
    } catch let cleanupError {
        return CleanupAfterFailureError(operationError: failure, cleanupError: cleanupError)
    }
    return failure
}

/// Deletes the reader VM, stopping it first when it was started.
///
/// The deletion runs in a task of its own, so cancelling the read doesn't
/// interrupt it; this waits for it either way.
///
/// - Parameters:
///   - containerId: Container id of a reader VM that isn't starting.
///   - vmLifecycle: Lifecycle that created the VM.
/// - Throws: The errors of ``ReaderVmLifecycle/deleteVm(containerId:)``.
private func deleteReaderVm(_ containerId: String, _ vmLifecycle: some ReaderVmLifecycle) async throws {
    try await Task { try await vmLifecycle.deleteVm(containerId: containerId) }.value
}
