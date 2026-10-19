import Foundation
import Testing
@testable import vmo

/// Checks how a VM command's output is collected, without a VM.
@Suite("Command output")
struct CommandOutputTests {
    /// Verifies that writes are kept whole and in order.
    @Test("A buffer keeps every write in order")
    func keepsWritesInOrder() throws {
        let buffer = CommandOutputBuffer()

        try buffer.write(Data("hello, ".utf8))
        try buffer.write(Data("world".utf8))

        #expect(buffer.output == CommandStreamOutput(bytes: Data("hello, world".utf8), isTruncated: false))
    }

    /// Verifies that closing ends the stream but keeps what was written.
    @Test("After close, a buffer rejects writes as a closed pipe and keeps its bytes")
    func rejectsWritesAfterClose() throws {
        let buffer = CommandOutputBuffer()
        try buffer.write(Data("kept".utf8))

        try buffer.close()
        try buffer.close()

        #expect(throws: POSIXError(.EPIPE)) {
            try buffer.write(Data("dropped".utf8))
        }
        #expect(buffer.output == CommandStreamOutput(bytes: Data("kept".utf8), isTruncated: false))
    }

    /// Verifies that concurrent writers lose no bytes.
    @Test("Concurrent writes are all kept")
    func keepsConcurrentWrites() async throws {
        let buffer = CommandOutputBuffer()

        try await withThrowingTaskGroup { group in
            for _ in 0..<100 {
                group.addTask { try buffer.write(Data("x".utf8)) }
            }
            try await group.waitForAll()
        }

        #expect(buffer.output.bytes == Data(repeating: UInt8(ascii: "x"), count: 100))
    }

    /// Verifies the inclusive limit: a stream of exactly the most bytes kept
    /// loses nothing.
    @Test("A buffer keeps a stream of exactly the most bytes kept, untruncated")
    func keepsStreamAtLimit() throws {
        let buffer = CommandOutputBuffer()
        let bytes = Data(repeating: UInt8(ascii: "x"), count: maximumKeptStreamByteCount)

        try buffer.write(bytes)

        #expect(buffer.output == CommandStreamOutput(bytes: bytes, isTruncated: false))
    }

    /// Verifies that the byte past the limit is dropped, within one write.
    @Test("A buffer drops the bytes of a write past the most bytes kept and reports the truncation")
    func truncatesWritePastLimit() throws {
        let buffer = CommandOutputBuffer()
        let bytes = Data(repeating: UInt8(ascii: "x"), count: maximumKeptStreamByteCount)

        try buffer.write(bytes + Data("y".utf8))

        #expect(buffer.output == CommandStreamOutput(bytes: bytes, isTruncated: true))
    }

    /// Verifies that a full buffer drops later writes without failing them,
    /// so Containerization keeps draining the command's pipe.
    @Test("A full buffer accepts and drops later writes and reports the truncation")
    func dropsWritesWhenFull() throws {
        let buffer = CommandOutputBuffer()
        let bytes = Data(repeating: UInt8(ascii: "x"), count: maximumKeptStreamByteCount)
        try buffer.write(bytes)

        try buffer.write(Data("dropped".utf8))

        #expect(buffer.output == CommandStreamOutput(bytes: bytes, isTruncated: true))
    }

    /// Verifies that the output keeps each stream apart, with the exit code.
    @Test("Output holds standard output, standard error, and the exit code")
    func buildsOutput() throws {
        let buffers = CommandOutputBuffers()
        try buffers.stdout.write(Data("out".utf8))
        try buffers.stderr.write(Data("err".utf8))

        let output = buffers.output(exitCode: 3)

        #expect(output.stdout == CommandStreamOutput(bytes: Data("out".utf8), isTruncated: false))
        #expect(output.stderr == CommandStreamOutput(bytes: Data("err".utf8), isTruncated: false))
        #expect(output.exitCode == 3)
    }
}
