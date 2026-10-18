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

        #expect(buffer.bytes == Data("hello, world".utf8))
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
        #expect(buffer.bytes == Data("kept".utf8))
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

        #expect(buffer.bytes == Data(repeating: UInt8(ascii: "x"), count: 100))
    }

    /// Verifies that the output keeps each stream apart, with the exit code.
    @Test("Output holds standard output, standard error, and the exit code")
    func buildsOutput() throws {
        let buffers = CommandOutputBuffers()
        try buffers.stdout.write(Data("out".utf8))
        try buffers.stderr.write(Data("err".utf8))

        let output = buffers.output(exitCode: 3)

        #expect(output.stdout == Data("out".utf8))
        #expect(output.stderr == Data("err".utf8))
        #expect(output.exitCode == 3)
    }
}
