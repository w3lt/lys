import Containerization
import Foundation

/// Image that boots every VM, pinned to the Containerization version vmo
/// builds with.
private let initfsReference = "ghcr.io/apple/containerization/vminit:0.52.0"

/// Creates the container manager vmo uses outside tests.
///
/// Its image store is vmo's own, `com.w3lt.lys-vmo` in the user's Application
/// Support directory, which Containerization creates when it's missing. It
/// pulls the vminit image when that store doesn't have it yet, and unpacks
/// the filesystem that VMs boot from out of that image unless the store holds
/// it unpacked from that image already; see
/// ``ImageStore/loadInitfs(reference:)``. It pulls the
/// ``readPageImageReference`` image at every start, so vmo reads pages with
/// the image its `latest` tag names at that time. It then deletes every other
/// image in the store, such as the reader image `latest` named before, with
/// the blobs only those images used, so the store holds vminit and one reader
/// image. It creates a vmnet network in shared mode. The network is a
/// ``SharedNetwork``, so every copy of the manager allocates addresses from
/// one record.
///
/// - Returns: A manager that stores images and VM files in vmo's image store.
/// - Throws: Containerization's error when vmnet refuses to create the
///   network, an image can't be pulled, for example without network access,
///   vminit can't be unpacked, or deleting the images vmo no longer uses
///   fails. The file system's error when the filesystem unpacked from vminit
///   can't be checked, its record exists but can't be read, either can't be
///   deleted, or a new unpack or its record can't be saved. Either way, vmo
///   doesn't start, even when an earlier pull left the reader image in the
///   store.
func createProductionContainerManager() async throws -> ContainerManager {
    // TODO(#200): this kernel path only exists on the author's machine, so
    // read-page can't boot its VMs on any other Mac. vmo needs another way to
    // get its kernel.
    let kernelPath = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/com.apple.container/kernels/vmlinux-6.18.35-197-debug")
    // Not Containerization's default store: other tools can share that one,
    // and deleting what vmo no longer uses there could delete their images or
    // the blobs of a pull they run at the same moment.
    let imageStorePath = URL.applicationSupportDirectory.appending(path: "com.w3lt.lys-vmo", directoryHint: .isDirectory)
    let network = SharedNetwork(try VmnetNetwork())
    let imageStore = try ImageStore(path: imageStorePath)
    let initfs = try await imageStore.loadInitfs(reference: initfsReference)
    let manager = try ContainerManager(
        kernel: Kernel(path: kernelPath, platform: .linuxArm),
        initfs: initfs,
        imageStore: imageStore,
        network: network
    )
    // Pulled now, even when the store has it: `latest` moves to each main
    // build, and a stored image would never follow it. A read can't pull it
    // instead, because pulling takes longer than a read's time limit.
    _ = try await manager.imageStore.pull(reference: readPageImageReference.text)
    try await manager.imageStore.deleteImages(except: [initfsReference, readPageImageReference.text])
    return manager
}
