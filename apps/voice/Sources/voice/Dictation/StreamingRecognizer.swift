import Foundation

/// The speech recognition model as the dictation engine drives it: one
/// stream of audio in, the text heard so far out.
///
/// A recognizer holds one stream at a time. The dictation engine makes
/// every call of one dictation in order and never overlaps two dictations,
/// so an implementation needs no ordering of its own.
protocol StreamingRecognizer: Sendable {
    /// Loads the model. Called once at startup.
    ///
    /// - Throws: The error that stopped loading.
    func loadModels() async throws
    /// Forgets the stream heard so far, so the next audio starts a new one.
    func reset() async
    /// Hears the next audio of the stream.
    ///
    /// - Parameter samples: 16 kHz mono samples within `[-1, 1]`.
    /// - Returns: The whole text heard since the last ``reset()``.
    /// - Throws: The error that stopped recognition, or `CancellationError`
    ///   when the calling task was cancelled.
    func addAudio(_ samples: [Float]) async throws -> String
    /// Hears the end of the stream.
    ///
    /// - Returns: The finished text of the stream.
    /// - Throws: The error that stopped recognition, or `CancellationError`
    ///   when the calling task was cancelled.
    func closeAudio() async throws -> String
}
