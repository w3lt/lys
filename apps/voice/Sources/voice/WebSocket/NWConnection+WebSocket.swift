import Foundation
import Network

/// One WebSocket message as a job connection reads it, before the job's
/// protocol validates it.
enum SocketMessage: Sendable {
    /// A UTF-8 text message with its payload.
    case text(String)
    /// A binary message with its payload, which is never empty.
    case binary(Data)
    /// The peer sent a close frame.
    case close
}

/// The peer closed the connection without a close frame, or sent an empty
/// message where a message was expected.
struct ConnectionClosedError: Error {}

extension NWConnection {
    /// Sends one WebSocket frame on this started connection.
    ///
    /// Network.framework serializes the sends of one connection, so frames
    /// leave in the order their sends began.
    ///
    /// - Parameters:
    ///   - data: The frame's payload; `nil` with the close opcode sends a
    ///     close frame.
    ///   - opcode: Kind of frame: text, binary, or close.
    ///   - closeCode: Close code of a close frame.
    /// - Throws: The connection's `NWError` when the frame cannot be sent,
    ///   as after the connection was cancelled.
    func sendSocketMessage(
        _ data: Data?,
        opcode: NWProtocolWebSocket.Opcode,
        closeCode: NWProtocolWebSocket.CloseCode? = nil
    ) async throws {
        let metadata = NWProtocolWebSocket.Metadata(opcode: opcode)
        if let closeCode {
            metadata.closeCode = closeCode
        }
        let context = NWConnection.ContentContext(identifier: "voice", metadata: [metadata])
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
            send(content: data, contentContext: context, isComplete: true, completion: .contentProcessed { error in
                continuation.resume(with: error.map { .failure($0) } ?? .success(()))
            })
        }
    }

    /// Reads the next WebSocket message of this started connection.
    ///
    /// Task cancellation does not interrupt a pending read; cancelling the
    /// connection does, and the read then throws.
    ///
    /// - Returns: The message. A text message is valid UTF-8, because
    ///   Network.framework fails the receive of one that is not.
    /// - Throws: The connection's `NWError` when receiving fails, a text
    ///   message that is not UTF-8 or a message over the listener's size
    ///   limit included, or ``ConnectionClosedError`` when the peer ended
    ///   the connection without a close frame or sent an empty message.
    func readSocketMessage() async throws -> SocketMessage {
        try await withCheckedThrowingContinuation { continuation in
            receiveMessage { content, context, _, error in
                continuation.resume(with: Self.parseReceivedMessage(content: content, context: context, error: error))
            }
        }
    }

    /// Parses what one receive delivered into a WebSocket message.
    ///
    /// - Parameters:
    ///   - content: The message's payload, if any.
    ///   - context: The receive's context, which carries the opcode.
    ///   - error: The receive's error, if it failed.
    /// - Returns: The message, or the failure ``readSocketMessage()``
    ///   throws: the receive's error, or ``ConnectionClosedError`` for a
    ///   payload that is missing or empty outside a close frame.
    private static func parseReceivedMessage(
        content: Data?,
        context: NWConnection.ContentContext?,
        error: NWError?
    ) -> Result<SocketMessage, any Error> {
        if let error { return .failure(error) }
        let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata
        if metadata?.opcode == .close { return .success(.close) }
        guard let content, !content.isEmpty else { return .failure(ConnectionClosedError()) }
        if metadata?.opcode == .binary { return .success(.binary(content)) }
        return .success(.text(String(decoding: content, as: UTF8.self)))
    }
}

extension NWConnection {
    /// Stops a sending task: cancels it, waits for it to end, and cancels
    /// this connection when it has not ended within `timeout`.
    ///
    /// Cancelling the task ends its wait for output but not a send already
    /// pending towards a peer that stopped reading; cancelling the
    /// connection fails that send, so the task ends and a close can proceed.
    /// The connection's cancellation is logged.
    ///
    /// - Parameters:
    ///   - sender: The task that sends on this connection.
    ///   - timeout: Longest wait for the task before the connection is
    ///     cancelled.
    func stopSender(_ sender: Task<Void, Never>, within timeout: Duration) async {
        sender.cancel()
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await sender.value }
            group.addTask { await self.cancelStalledSend(after: timeout) }
            await group.next()
            group.cancelAll()
        }
    }

    /// Cancels this connection once `timeout` passed, and logs it; a wait
    /// that was cancelled first does nothing.
    ///
    /// - Parameter timeout: Longest wait for the sending task.
    private func cancelStalledSend(after timeout: Duration) async {
        try? await Task.sleep(for: timeout)
        guard !Task.isCancelled else { return }
        print("voice: connection \(endpoint) took no message for \(timeout); cancelling it")
        cancel()
    }

    /// Cancels this connection after a grace period, so a peer that never
    /// answers a close frame does not hold the connection open forever.
    ///
    /// - Parameter grace: How long the peer has to answer the close frame.
    func startCancelTimer(after grace: Duration = .seconds(1)) {
        Task {
            try? await Task.sleep(for: grace)
            self.cancel()
        }
    }
}
