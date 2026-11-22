import Foundation

/// One speech synthesis session: enqueued sentences are spoken in order and
/// audio frames arrive on a stream.
///
/// Closing the session by calling ``cancel()`` ends the frame stream and
/// stops synthesis; the frames already handed out remain valid.
protocol SpeechSession: Sendable {
    /// Queues one sentence (or any text unit) to be spoken.
    func addText(_ text: String)
    /// Signals that no more text follows; the frame stream ends once
    /// everything enqueued has been synthesized.
    func closeText()
    /// Abandons the speech immediately and ends the frame stream.
    func cancel() async
    /// The synthesized 24 kHz mono audio frames, in order.
    var frames: AsyncThrowingStream<[Float], any Error> { get }
}

/// Creates speech sessions and loads the models they need.
///
/// Concurrency model: the engine is used from the WebSocket serving tasks;
/// implementations must tolerate concurrent calls.
protocol SpeechEngine: Sendable {
    /// Loads the models. Called once at startup; until it returns, speech
    /// requests are refused.
    ///
    /// - Throws: The error that stopped model loading; the engine stays not
    ///   ready and the caller keeps refusing speech until it succeeds.
    func loadModels() async throws
    /// Whether the models are loaded and speech can start.
    var isReady: Bool { get }
    /// Starts one speech session.
    ///
    /// - Throws: The error that stopped session creation, for example the
    ///   models failing to load.
    func startSession() async throws -> any SpeechSession
}
