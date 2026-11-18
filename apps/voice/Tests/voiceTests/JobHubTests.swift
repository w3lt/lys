import Foundation
import Testing
@testable import voice

/// Checks that only one job of a kind runs at a time.
@Suite("Job hub")
struct JobHubTests {
    /// Records the supersede calls the hub makes, in order.
    ///
    /// Concurrency model: serialized. The calls are read and written under
    /// ``lock``.
    private final class SupersedeRecorder: @unchecked Sendable {
        /// Guards ``recorded``.
        private let lock = NSLock()
        /// Identities of the superseded jobs, in order.
        private var recorded: [UUID] = []

        /// Identities of the superseded jobs, in order.
        var calls: [UUID] {
            lock.withLock { recorded }
        }

        /// Records that the job `id` was superseded.
        ///
        /// - Parameter id: Identity of the superseded job.
        func add(_ id: UUID) {
            lock.withLock { recorded.append(id) }
        }
    }

    /// Verifies a second job supersedes the first, exactly once.
    @Test("Beginning a job supersedes the previous one")
    func supersedesPreviousJob() {
        let hub = JobHub()
        let recorder = SupersedeRecorder()
        let first = UUID()
        let second = UUID()

        hub.register(id: first) { recorder.add(first) }
        hub.register(id: second) { recorder.add(second) }

        #expect(recorder.calls == [first])
    }

    /// Verifies ending the active job removes it without superseding it.
    @Test("Ending the active job clears it")
    func endClearsActiveJob() {
        let hub = JobHub()
        let recorder = SupersedeRecorder()
        let first = UUID()
        let second = UUID()

        hub.register(id: first) { recorder.add(first) }
        hub.remove(first)
        hub.register(id: second) { recorder.add(second) }

        #expect(recorder.calls.isEmpty)
    }

    /// Verifies ending a job that was already superseded does nothing, so
    /// it cannot remove the job that replaced it.
    @Test("Ending a superseded job does not clear the active one")
    func endingSupersededJobDoesNothing() {
        let hub = JobHub()
        let recorder = SupersedeRecorder()
        let first = UUID()
        let second = UUID()
        let third = UUID()

        hub.register(id: first) { recorder.add(first) }
        hub.register(id: second) { recorder.add(second) }
        hub.remove(first)
        hub.remove(second)
        hub.register(id: third) { recorder.add(third) }

        #expect(recorder.calls == [first])
    }
}
