import Dispatch
import Foundation

/// Suspends until the process receives one of `signals`, or until the calling
/// task is cancelled.
///
/// While it waits, the signals' previous actions are replaced by "ignore", so a
/// signal that would end the process is only observed here. A signal that
/// arrives before the wait is set up is not observed. The previous actions
/// come back when the wait ends, so a repeated signal then has its usual
/// effect.
///
/// - Parameter signals: Signal numbers to wait for, such as `SIGINT` and
///   `SIGTERM`.
func waitForSignal(in signals: [Int32]) async {
    let (deliveries, continuation) = AsyncStream.makeStream(of: Void.self, bufferingPolicy: .bufferingNewest(1))
    let previousActions = signals.map { signal($0, SIG_IGN) }
    let sources = signals.map { number in
        let source = DispatchSource.makeSignalSource(signal: number)
        source.setEventHandler { continuation.yield() }
        source.resume()
        return source
    }
    defer {
        sources.forEach { $0.cancel() }
        zip(signals, previousActions).forEach { signal($0, $1) }
    }
    for await _ in deliveries {
        return
    }
}
