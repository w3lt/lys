import Containerization
import Foundation

/// Image that boots every VM, pinned to the Containerization version vmo
/// builds with.
private let initfsReference = "ghcr.io/apple/containerization/vminit:0.52.0"

/// Creates the container manager vmo uses outside tests.
///
/// It pulls the vminit image when Containerization's default image store
/// doesn't have it yet, and pulls the ``readPageImageReference`` image at
/// every start, so vmo reads pages with the image its `latest` tag names at
/// that time. It creates a vmnet network in shared mode. The network is a
/// ``SharedNetwork``, so every copy of the manager allocates addresses from
/// one record.
///
/// - Returns: A manager that stores images and VM files in Containerization's
///   default image store.
/// - Throws: Containerization's error when vmnet refuses to create the network
///   or an image can't be pulled, for example without network access; vmo
///   then doesn't start, even when an earlier pull left the reader image in
///   the store.
func createProductionContainerManager() async throws -> ContainerManager {
    // TODO(#200): this kernel path only exists on the author's machine, so
    // read-page can't boot its VMs on any other Mac. vmo needs another way to
    // get its kernel.
    let kernelPath = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/com.apple.container/kernels/vmlinux-6.18.35-197-debug")
    let manager = try await ContainerManager(
        kernel: Kernel(path: kernelPath, platform: .linuxArm),
        initfsReference: initfsReference,
        network: SharedNetwork(try VmnetNetwork())
    )
    // Pulled now, even when the store has it: `latest` moves to each main
    // build, and a stored image would never follow it. A read can't pull it
    // instead, because pulling takes longer than a read's time limit.
    _ = try await manager.imageStore.pull(reference: readPageImageReference)
    return manager
}
