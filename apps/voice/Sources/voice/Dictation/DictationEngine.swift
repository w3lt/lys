import Foundation
import Synchronization

/// One step of a dictation's text, as the engine reports it.
enum DictationUpdate: Equatable, Sendable {
    /// The whole text heard so far; it replaces the previous one.
    case partial(String)
    /// The finished text; nothing follows it.
    case final(String)
}

/// The dictation's audio arrived faster than the recognizer read it for so
/// long that ``DictationEngine/maximumQueuedMessageCount`` messages waited.
struct AudioBacklogError: Error {}

/// One instruction a dictation session queues for its worker.
private enum DictationCommand: Sendable {
    /// Hear these samples next.
    case audio([Float])
    /// No more audio follows; report the finished text.
    case close
}

/// One dictation: audio added in order comes back as text updates on a
/// stream.
///
/// The update stream yields a ``DictationUpdate/partial(_:)`` whenever the
/// text heard so far changed, and one ``DictationUpdate/final(_:)`` after
/// ``closeAudio()``, then ends. It ends without a final text when the
/// session was cancelled, and with an error when recognition failed or the
/// audio fell too far behind.
///
/// Concurrency model: reentrant. The class holds no mutable state of its
/// own; the two stream continuations and the worker task are safe to use
/// from any task.
final class DictationSession: Sendable {
    /// The dictation's text updates, in order.
    let updates: AsyncThrowingStream<DictationUpdate, any Error>
    /// Producer side of the worker's instructions.
    private let commandInput: AsyncStream<DictationCommand>.Continuation
    /// Producer side of ``updates``.
    private let updateOutput: AsyncThrowingStream<DictationUpdate, any Error>.Continuation
    /// The task that feeds the recognizer.
    private let worker: Task<Void, Never>

    /// Wraps the streams and the worker of a dictation the engine started.
    ///
    /// - Parameters:
    ///   - updates: The dictation's text updates: the stream and its
    ///     producer side.
    ///   - commandInput: Producer side of the worker's instructions.
    ///   - worker: The task that feeds the recognizer.
    fileprivate init(
        updates: (
            stream: AsyncThrowingStream<DictationUpdate, any Error>,
            continuation: AsyncThrowingStream<DictationUpdate, any Error>.Continuation
        ),
        commandInput: AsyncStream<DictationCommand>.Continuation,
        worker: Task<Void, Never>
    ) {
        self.updates = updates.stream
        self.updateOutput = updates.continuation
        self.commandInput = commandInput
        self.worker = worker
    }

    /// Queues audio to be heard after everything queued before it.
    ///
    /// When ``DictationEngine/maximumQueuedMessageCount`` messages already
    /// wait, the dictation fails: its updates end with
    /// ``AudioBacklogError``. Audio added after ``closeAudio()`` or
    /// ``cancel()`` is dropped.
    ///
    /// - Parameter samples: 16 kHz mono samples within `[-1, 1]`.
    func addAudio(_ samples: [Float]) {
        addCommand(.audio(samples))
    }

    /// Says that no more audio follows; the final text is reported once
    /// everything queued was heard. A second call does nothing. Like audio,
    /// it fails the dictation when
    /// ``DictationEngine/maximumQueuedMessageCount`` messages already wait.
    func closeAudio() {
        addCommand(.close)
        commandInput.finish()
    }

    /// Abandons the dictation: its updates end, and the recognizer stops
    /// after the audio it is reading.
    func cancel() {
        commandInput.finish()
        worker.cancel()
        updateOutput.finish()
    }

    /// Queues one instruction, failing the dictation when the queue is full.
    ///
    /// - Parameter command: The instruction.
    private func addCommand(_ command: DictationCommand) {
        guard case .dropped = commandInput.yield(command) else { return }
        updateOutput.finish(throwing: AudioBacklogError())
        commandInput.finish()
        worker.cancel()
    }
}

/// Turns dictations into text with one recognizer, one dictation after
/// another.
///
/// The recognizer holds one stream, so a dictation's worker starts only
/// once the worker of the dictation before it ended, and clears the stream
/// first. The servers cancel the older dictation when a newer one starts,
/// so the wait is short.
///
/// Concurrency model: serialized. Readiness and the latest worker are read
/// and written under their `Mutex`; each dictation's worker is the only
/// task that calls the recognizer while it runs.
final class DictationEngine: Sendable {
    /// Readiness and the chain of workers, guarded by their `Mutex`.
    private struct State {
        /// Whether ``loadModels()`` loaded the model.
        var isReady = false
        /// The worker of the dictation started last, if any.
        var latestWorker: Task<Void, Never>?

        /// Starts a dictation's worker behind the worker of the dictation
        /// before it, and keeps it as the latest.
        ///
        /// - Parameter work: What the worker does once the worker before
        ///   it ended.
        /// - Returns: The new worker.
        mutating func startWorker(_ work: @escaping @Sendable () async -> Void) -> Task<Void, Never> {
            let previous = latestWorker
            let worker = Task {
                await previous?.value
                await work()
            }
            latestWorker = worker
            return worker
        }
    }

    /// Most messages of one dictation, its audio and its closing stop, that
    /// may wait for the recognizer, inclusive: 30 s of audio at the
    /// desktop's 100 ms per message. A dictation that falls further behind
    /// fails.
    static let maximumQueuedMessageCount = 300

    /// The model.
    private let recognizer: any StreamingRecognizer
    /// Readiness and the latest worker.
    private let state = Mutex(State())

    /// Creates the engine without touching the model.
    ///
    /// - Parameter recognizer: The model to dictate with.
    init(recognizer: any StreamingRecognizer) {
        self.recognizer = recognizer
    }

    /// Loads the model, then reports the engine as ready.
    ///
    /// - Throws: The error that stopped loading; the engine stays not ready.
    func loadModels() async throws {
        try await recognizer.loadModels()
        state.withLock { $0.isReady = true }
    }

    /// Whether the model is loaded.
    var isReady: Bool { state.withLock { $0.isReady } }

    /// Starts one dictation, which begins hearing once the dictation
    /// started before it ended.
    ///
    /// - Returns: The dictation's session.
    func startSession() -> DictationSession {
        let updates = AsyncThrowingStream.makeStream(of: DictationUpdate.self)
        let (commands, commandInput) = AsyncStream.makeStream(
            of: DictationCommand.self,
            bufferingPolicy: .bufferingOldest(Self.maximumQueuedMessageCount)
        )
        let recognizer = self.recognizer
        let worker = state.withLock { state in
            state.startWorker {
                await Self.sendDictationUpdates(with: recognizer, commands: commands, updates: updates.continuation)
            }
        }
        return DictationSession(updates: updates, commandInput: commandInput, worker: worker)
    }

    /// Sends one dictation's updates and ends them: normally once the
    /// dictation closed or was cancelled, and with the error when the
    /// recognizer failed.
    ///
    /// - Parameters:
    ///   - recognizer: The model, which no other task uses meanwhile.
    ///   - commands: The dictation's instructions, in order.
    ///   - updates: Where the dictation's text goes.
    private static func sendDictationUpdates(
        with recognizer: any StreamingRecognizer,
        commands: AsyncStream<DictationCommand>,
        updates: AsyncThrowingStream<DictationUpdate, any Error>.Continuation
    ) async {
        do {
            try await followDictationCommands(with: recognizer, commands: commands, updates: updates)
            updates.finish()
        } catch is CancellationError {
            updates.finish()
        } catch {
            updates.finish(throwing: error)
        }
    }

    /// Follows one dictation's instructions until the session ends them:
    /// feeds its audio to the recognizer in order and reports its text, a
    /// partial text whenever the text changed and the final text once the
    /// audio closed.
    ///
    /// - Parameters:
    ///   - recognizer: The model, cleared before the first audio.
    ///   - commands: The dictation's instructions, in order.
    ///   - updates: Where the dictation's text goes.
    /// - Throws: `CancellationError` when the dictation was cancelled, and
    ///   the recognizer's error when it failed.
    private static func followDictationCommands(
        with recognizer: any StreamingRecognizer,
        commands: AsyncStream<DictationCommand>,
        updates: AsyncThrowingStream<DictationUpdate, any Error>.Continuation
    ) async throws {
        try Task.checkCancellation()
        await recognizer.reset()
        var heard = ""
        for await command in commands {
            try Task.checkCancellation()
            switch command {
            case .audio(let samples):
                let text = try await recognizer.sendAudio(samples)
                if text != heard { updates.yield(.partial(text)) }
                heard = text
            case .close:
                updates.yield(.final(try await recognizer.closeAudio()))
            }
        }
    }
}
