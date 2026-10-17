import Containerization
import Testing
@testable import vmo

/// Failures of ``RecordingNetwork``.
private enum RecordingNetworkError: Error, Equatable {
    /// The id already holds an interface.
    case duplicateInterface(id: String)
    /// The id holds no interface.
    case unknownInterface(id: String)
}

/// A network that keeps its allocation records inside its value, as
/// `VmnetNetwork` does, so that copies of it diverge.
private struct RecordingNetwork: Network {
    /// Ids that hold an interface.
    private var interfaceIds: Set<String> = []

    /// Records an interface for `id`.
    ///
    /// - Parameter id: Container the interface is for.
    /// - Returns: `nil`; tests only observe the records.
    /// - Throws: ``RecordingNetworkError/duplicateInterface(id:)`` when `id`
    ///   already holds one.
    mutating func createInterface(_ id: String) throws -> (any Interface)? {
        guard interfaceIds.insert(id).inserted else {
            throw RecordingNetworkError.duplicateInterface(id: id)
        }
        return nil
    }

    /// Removes the interface record of `id`.
    ///
    /// - Parameter id: Container whose interface is released.
    /// - Throws: ``RecordingNetworkError/unknownInterface(id:)`` when `id`
    ///   holds none.
    mutating func releaseInterface(_ id: String) throws {
        guard interfaceIds.remove(id) != nil else {
            throw RecordingNetworkError.unknownInterface(id: id)
        }
    }
}

/// Checks that every holder of a shared network works on one set of
/// allocation records.
@Suite("Shared network")
struct SharedNetworkTests {
    /// Verifies the problem the wrapper exists for: copies of a value network
    /// keep separate records.
    @Test("Copies of a value network keep separate records")
    func valueNetworkCopiesDiverge() throws {
        var allocatingCopy = RecordingNetwork()
        var releasingCopy = allocatingCopy

        _ = try allocatingCopy.createInterface("vm")

        #expect(throws: RecordingNetworkError.unknownInterface(id: "vm")) {
            try releasingCopy.releaseInterface("vm")
        }
    }

    /// Verifies that a release through one holder reaches the allocation
    /// another holder made, exactly once.
    @Test("A release through one holder removes another holder's allocation")
    func holdersShareRecords() throws {
        let sharedNetwork = SharedNetwork(RecordingNetwork())
        var allocatingHolder: any Network = sharedNetwork
        var releasingHolder: any Network = sharedNetwork

        _ = try allocatingHolder.createInterface("vm")
        try releasingHolder.releaseInterface("vm")

        #expect(throws: RecordingNetworkError.unknownInterface(id: "vm")) {
            try allocatingHolder.releaseInterface("vm")
        }
    }

    /// Verifies that the wrapped network's failures reach the caller.
    @Test("Passes the wrapped network's errors through")
    func passesErrorsThrough() throws {
        let sharedNetwork = SharedNetwork(RecordingNetwork())

        _ = try sharedNetwork.createInterface("vm")

        #expect(throws: RecordingNetworkError.duplicateInterface(id: "vm")) {
            try sharedNetwork.createInterface("vm")
        }
    }

    /// Verifies that overlapping allocations from many tasks are each
    /// recorded once.
    @Test("Concurrent allocations are each recorded once")
    func recordsConcurrentAllocations() async throws {
        let sharedNetwork = SharedNetwork(RecordingNetwork())
        let ids = (0..<64).map { "vm-\($0)" }

        try await withThrowingTaskGroup(of: Void.self) { group in
            for id in ids {
                group.addTask { _ = try sharedNetwork.createInterface(id) }
            }
            try await group.waitForAll()
        }

        for id in ids {
            try sharedNetwork.releaseInterface(id)
        }
    }
}
