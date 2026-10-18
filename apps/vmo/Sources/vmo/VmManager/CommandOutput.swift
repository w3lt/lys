import Containerization
import Foundation
import Synchronization

/// What a VM's command wrote and how it exited.
struct CommandOutput: Sendable {
    /// Bytes the command wrote to standard output.
    let stdout: Data
    /// Bytes the command wrote to standard error.
    let stderr: Data
    /// The command's exit code. A non-zero code is the command's own failure,
    /// not the manager's.
    let exitCode: Int32
}

/// The two buffers one VM's command writes to.
struct CommandOutputBuffers: Sendable {
    /// Collects the command's standard output.
    let stdout = CommandOutputBuffer()
    /// Collects the command's standard error.
    let stderr = CommandOutputBuffer()

    /// What the command has written so far, with its exit code.
    ///
    /// - Parameter exitCode: The command's exit code.
    /// - Returns: Copies of both buffers' bytes and `exitCode`.
    func output(exitCode: Int32) -> CommandOutput {
        CommandOutput(stdout: stdout.bytes, stderr: stderr.bytes, exitCode: exitCode)
    }
}

/// Owns the bytes one output stream of a VM's command writes, so the manager
/// can read them once the command exits.
///
/// Invariant: `contents.bytes` holds every byte written before the buffer was
/// closed, in write order.
///
/// Lifecycle: open → closed. ``close()`` ends the stream; the bytes stay
/// readable.
///
/// Concurrency model: thread-safe. Containerization writes from its own
/// threads while the manager reads; a mutex serializes both.
final class CommandOutputBuffer: Writer {
    /// The bytes written so far, and whether the stream has ended.
    private struct Contents {
        /// Bytes written so far, in write order.
        var bytes = Data()
        /// Whether ``CommandOutputBuffer/close()`` has ended the stream.
        var isClosed = false
    }

    /// The stream's contents, guarded for writes from other threads.
    private let contents = Mutex(Contents())

    /// A copy of every byte written so far.
    var bytes: Data {
        contents.withLock { $0.bytes }
    }

    /// Appends bytes the command wrote.
    ///
    /// - Parameter data: Bytes to append.
    /// - Throws: `POSIXError(.EPIPE)` when the stream has ended, as writing
    ///   to a closed pipe does.
    func write(_ data: Data) throws {
        try contents.withLock { contents in
            guard !contents.isClosed else {
                throw POSIXError(.EPIPE)
            }
            contents.bytes.append(data)
        }
    }

    /// Ends the stream: the bytes stay readable and later writes throw.
    ///
    /// Repeated calls do nothing more. Containerization 0.52.0 never calls it;
    /// it stops writing when the command's stream ends.
    func close() throws {
        contents.withLock { $0.isClosed = true }
    }
}
