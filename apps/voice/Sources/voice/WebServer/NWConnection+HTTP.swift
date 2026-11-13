import Foundation
import Network

/// Bytes delivered by one receive completion.
private struct ReceivedChunk: Sendable {
    /// Received bytes in arrival order; empty when the completion carried none.
    let bytes: Data
    /// Whether the peer ended its outgoing stream with this completion.
    let isFinal: Bool
}

extension NWConnection {
    /// Reads the request head at the start of this started connection.
    ///
    /// Reads at most ``maximumReceivedRequestHeadByteCount`` bytes. Bytes after
    /// the head, such as the start of a request body, are discarded. Task
    /// cancellation does not interrupt a pending read; cancelling the
    /// connection does, and the read then throws.
    ///
    /// - Returns: The head without the empty line that ends it.
    /// - Throws: ``HTTPRequestError/requestHeadTooLarge`` when the head exceeds
    ///   ``maximumRequestHeadByteCount`` bytes;
    ///   ``HTTPRequestError/malformedRequest`` when the peer ends its stream
    ///   before the head is complete; the connection's `NWError` when
    ///   receiving fails.
    func readRequestHead() async throws -> Data {
        var receivedBytes = Data()
        while true {
            let remainingByteCount = maximumReceivedRequestHeadByteCount - receivedBytes.count
            let chunk = try await readChunk(maximumByteCount: remainingByteCount)
            receivedBytes.append(chunk.bytes)
            if let head = try findRequestHead(in: receivedBytes) {
                return head
            }
            guard !chunk.isFinal else {
                throw HTTPRequestError.malformedRequest
            }
        }
    }

    /// Sends one complete response and ends this connection's outgoing stream.
    ///
    /// Returns once Network.framework has processed the bytes for sending,
    /// which does not prove that the peer received them. Task cancellation
    /// does not interrupt a pending send; cancelling the connection does.
    ///
    /// - Parameter response: The only response this connection sends.
    /// - Throws: The connection's `NWError` when sending fails.
    func sendResponse(_ response: HTTPResponse) async throws {
        let message = response.buildWireMessage()
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
            send(content: message, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { error in
                continuation.resume(with: buildSendResult(error: error))
            })
        }
    }

    /// Receives the next bytes available on this connection.
    ///
    /// - Parameter maximumByteCount: Most bytes to accept in this read; at
    ///   least 1.
    /// - Returns: The received bytes, possibly none, and whether the peer ended
    ///   its stream.
    /// - Throws: The connection's `NWError` when receiving fails.
    private func readChunk(maximumByteCount: Int) async throws -> ReceivedChunk {
        try await withCheckedThrowingContinuation { continuation in
            receive(minimumIncompleteLength: 1, maximumLength: maximumByteCount) { content, _, isComplete, error in
                continuation.resume(with: buildReceivedChunkResult(content: content, isComplete: isComplete, error: error))
            }
        }
    }
}

/// Converts one receive completion into its chunk or its failure.
///
/// - Parameters:
///   - content: Bytes the completion delivered, or `nil` when it delivered
///     none.
///   - isComplete: Whether the peer ended its outgoing stream.
///   - error: Failure the completion reported.
/// - Returns: The failure when `error` is set; otherwise the received chunk.
private func buildReceivedChunkResult(
    content: Data?,
    isComplete: Bool,
    error: NWError?
) -> Result<ReceivedChunk, NWError> {
    if let error {
        return .failure(error)
    }
    let chunk = ReceivedChunk(bytes: content ?? Data(), isFinal: isComplete)
    return .success(chunk)
}

/// Converts one send completion into success or its failure.
///
/// - Parameter error: Failure the completion reported.
/// - Returns: The failure when `error` is set; otherwise success.
private func buildSendResult(error: NWError?) -> Result<Void, NWError> {
    guard let error else {
        return .success(())
    }
    return .failure(error)
}
