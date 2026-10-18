import Containerization
import Foundation
import Synchronization

/// Most bytes vmo keeps of one output stream of a VM's command: 64 MiB. Bytes
/// written past it are dropped, so a command can't make vmo hold more than
/// this in memory per stream.
let maximumKeptStreamByteCount = 64 * 1_024 * 1_024

/// What a VM's command wrote and how it exited.
struct CommandOutput: Sendable {
    /// What the command wrote to standard output.
    let stdout: CommandStreamOutput
    /// What the command wrote to standard error.
    let stderr: CommandStreamOutput
    /// The command's exit code. A non-zero code is the command's own failure,
    /// not the manager's.
    let exitCode: Int32
}

/// What a VM's command wrote to one output stream, as far as vmo kept it.
struct CommandStreamOutput: Equatable, Sendable {
    /// The bytes kept, in write order: at most
    /// ``maximumKeptStreamByteCount``, the first ones the command wrote.
    let bytes: Data
    /// Whether the command wrote more than ``maximumKeptStreamByteCount``
    /// bytes, so that the bytes after them were dropped.
    let isTruncated: Bool
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
    /// - Returns: Copies of both buffers' contents and `exitCode`.
    func output(exitCode: Int32) -> CommandOutput {
        CommandOutput(stdout: stdout.output, stderr: stderr.output, exitCode: exitCode)
    }
}

/// Owns the bytes one output stream of a VM's command writes, so the manager
/// can read them once the command exits.
///
/// Invariant: `contents.bytes` holds the first bytes written before the buffer
/// was closed, in write order, up to ``maximumKeptStreamByteCount``.
/// `contents.isTruncated` is `true` exactly when a byte written before the
/// close was dropped because that limit was reached.
///
/// Lifecycle: open → closed. ``close()`` ends the stream; the bytes stay
/// readable.
///
/// Concurrency model: thread-safe. Containerization writes from its own
/// threads while the manager reads; a mutex serializes both.
final class CommandOutputBuffer: Writer {
    /// The bytes kept so far, and whether the stream has ended.
    private struct Contents {
        /// Bytes kept so far, in write order.
        var bytes = Data()
        /// Whether a write was cut or dropped because `bytes` was full.
        var isTruncated = false
        /// Whether ``CommandOutputBuffer/close()`` has ended the stream.
        var isClosed = false

        /// Appends as much of `data` as fits under
        /// ``maximumKeptStreamByteCount`` and drops the rest.
        ///
        /// - Parameter data: Bytes the command wrote.
        /// - Throws: `POSIXError(.EPIPE)` when the stream has ended.
        mutating func append(_ data: Data) throws {
            guard !isClosed else {
                throw POSIXError(.EPIPE)
            }
            let keptByteCount = min(data.count, maximumKeptStreamByteCount - bytes.count)
            bytes.append(data.prefix(keptByteCount))
            isTruncated = isTruncated || keptByteCount < data.count
        }
    }

    /// The stream's contents, guarded for writes from other threads.
    private let contents = Mutex(Contents())

    /// A copy of the bytes kept so far, and whether any were dropped.
    var output: CommandStreamOutput {
        contents.withLock { CommandStreamOutput(bytes: $0.bytes, isTruncated: $0.isTruncated) }
    }

    /// Appends bytes the command wrote, as far as the buffer has room.
    ///
    /// Bytes past ``maximumKeptStreamByteCount`` are dropped without an error,
    /// so Containerization keeps reading the stream and the command never
    /// blocks on a full pipe.
    ///
    /// - Parameter data: Bytes to append.
    /// - Throws: `POSIXError(.EPIPE)` when the stream has ended, as writing
    ///   to a closed pipe does.
    func write(_ data: Data) throws {
        try contents.withLock { try $0.append(data) }
    }

    /// Ends the stream: the bytes stay readable and later writes throw.
    ///
    /// Repeated calls do nothing more. Containerization 0.52.0 never calls it;
    /// it stops writing when the command's stream ends.
    func close() throws {
        contents.withLock { $0.isClosed = true }
    }
}
