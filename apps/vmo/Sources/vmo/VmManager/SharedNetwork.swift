import Containerization
import Synchronization

/// Owns one network to let every copy of a `ContainerManager` allocate
/// addresses from the same records, while guaranteeing that allocations and
/// releases run one at a time.
///
/// `ContainerManager` is a value. In Containerization 0.52.0, `VmnetNetwork`
/// is a value too and keeps its allocation records inside it, so each copy of
/// a manager would get its own records: a release on one copy would miss the
/// allocation made on another and leak that address. Copies of a manager hold
/// this class by reference instead, so they all share one network.
///
/// Invariant: the wrapped network is reached only through the lock.
///
/// Resources: the wrapped network is owned. It needs no explicit release;
/// `VmnetNetwork` frees its vmnet network with its last reference.
///
/// Concurrency model: serialized. The lock admits one allocation or release at
/// a time. Both calls are synchronous, so nothing suspends while holding it.
final class SharedNetwork: Network {
    /// The network every copy allocates from.
    private let network: Mutex<any Network>

    /// Wraps a network so copies of the manager holding it share its records.
    ///
    /// - Parameter network: Network to share. The caller gives up its copy.
    init(_ network: any Network) {
        self.network = Mutex(network)
    }

    /// Allocates an interface through the wrapped network; see
    /// `Network.createInterface(_:)`.
    ///
    /// - Parameter id: Container the interface is for.
    /// - Returns: The wrapped network's interface.
    /// - Throws: The wrapped network's error.
    func createInterface(_ id: String) throws -> (any Interface)? {
        try network.withLock { lockedNetwork in
            try lockedNetwork.createInterface(id)
        }
    }

    /// Releases an interface through the wrapped network; see
    /// `Network.releaseInterface(_:)`.
    ///
    /// - Parameter id: Container whose interface is released.
    /// - Throws: The wrapped network's error.
    func releaseInterface(_ id: String) throws {
        try network.withLock { lockedNetwork in
            try lockedNetwork.releaseInterface(id)
        }
    }
}
