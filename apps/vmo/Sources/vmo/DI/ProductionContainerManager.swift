import Containerization
import Foundation

/// Image that boots every VM, pinned to the Containerization version vmo
/// builds with.
private let initfsReference = "ghcr.io/apple/containerization/vminit:0.52.0"

/// Creates the container manager vmo uses outside tests.
///
/// It pulls the vminit image when Containerization's default image store
/// doesn't have it yet, and creates a vmnet network in shared mode. The network
/// is a ``SharedNetwork``, so every copy of the manager allocates addresses
/// from one record.
///
/// - Returns: A manager that stores images and VM files in Containerization's
///   default image store.
/// - Throws: Containerization's error when vmnet refuses to create the network
///   or the vminit image can't be pulled.
func createProductionContainerManager() async throws -> ContainerManager {
    // TODO(#190): this kernel path only exists on the author's machine. vmo
    // needs another way to get its kernel before read-page creates VMs.
    let kernelPath = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/com.apple.container/kernels/vmlinux-6.18.35-197-debug")
    return try await ContainerManager(
        kernel: Kernel(path: kernelPath, platform: .linuxArm),
        initfsReference: initfsReference,
        network: SharedNetwork(try VmnetNetwork())
    )
}
