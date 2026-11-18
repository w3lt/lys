import Foundation
import Testing
@testable import voice

/// Thrown by a model load that fails in a test.
private struct FakeLoadError: Error {}

/// Thrown by a service that fails in a test.
private struct FakeServiceError: Error {}

/// Records how each child of a run ended, in order.
///
/// Concurrency model: serialized by the actor.
private actor EndLog {
    /// What ended, in order.
    private(set) var entries: [String] = []

    /// Records one end.
    ///
    /// - Parameter entry: What ended, and how.
    func add(_ entry: String) {
        entries.append(entry)
    }
}

/// Waits until the calling task is cancelled, then records that.
///
/// - Parameters:
///   - name: The child, as the log names it.
///   - log: Log that receives "`name` cancelled".
private func waitForCancellation(of name: String, in log: EndLog) async {
    try? await Task.sleep(for: .seconds(60))
    await log.add("\(name) cancelled")
}

/// Checks how voice's main group ends.
@Suite("Serving voice", .timeLimit(.minutes(1)))
struct ServeVoiceTests {
    /// Verifies the run goes on once the models loaded, until a service ends.
    @Test func keepsServingOnceTheModelsLoad() async throws {
        let log = EndLog()
        try await serveVoice(
            loadModels: { await log.add("models loaded") },
            services: [
                {
                    // Cancellation fails the sleep, so the entry below
                    // shows that the service was not cancelled.
                    try await Task.sleep(for: .milliseconds(300))
                    await log.add("service ended")
                },
            ]
        )
        #expect(await log.entries == ["models loaded", "service ended"])
    }

    /// Verifies a failed model load ends the run with its cause, cancelling
    /// the services.
    @Test func stopsWhenTheModelsFailToLoad() async throws {
        let log = EndLog()
        let error = await #expect(throws: ModelLoadError.self) {
            try await serveVoice(
                loadModels: { throw FakeLoadError() },
                services: [{ await waitForCancellation(of: "service", in: log) }]
            )
        }
        #expect(error?.cause is FakeLoadError)
        #expect(await log.entries == ["service cancelled"])
    }

    /// Verifies the first service that ends, such as the signal wait, ends
    /// the run and cancels the model load and the other services.
    @Test func stopsWhenAServiceEnds() async throws {
        let log = EndLog()
        try await serveVoice(
            loadModels: { await waitForCancellation(of: "models", in: log) },
            services: [
                { await log.add("signal") },
                { await waitForCancellation(of: "server", in: log) },
            ]
        )
        let entries = await log.entries
        #expect(entries.first == "signal")
        #expect(Set(entries) == ["signal", "models cancelled", "server cancelled"])
    }

    /// Verifies a failing server ends the run with its error.
    @Test func failsWhenAServerFails() async throws {
        let log = EndLog()
        await #expect(throws: FakeServiceError.self) {
            try await serveVoice(
                loadModels: {},
                services: [
                    { throw FakeServiceError() },
                    { await waitForCancellation(of: "server", in: log) },
                ]
            )
        }
        #expect(await log.entries == ["server cancelled"])
    }
}
