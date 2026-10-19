import Containerization
import Foundation
import Testing

/// Owns one test's temporary directory to hold the files of container managers
/// created in it, while guaranteeing that the directory is removed when the
/// test releases it.
///
/// Concurrency model: single-owner. One test creates, uses, and releases it.
final class TemporaryContainerRoot {
    /// The directory. It exists from creation until release.
    let url: URL

    /// Creates an empty temporary directory.
    ///
    /// - Throws: The file system's error when the directory can't be created.
    init() throws {
        url = FileManager.default.temporaryDirectory
            .appending(path: "vmoTests-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false)
    }

    /// Removes the directory, recording a test issue when it can't.
    deinit {
        do {
            try FileManager.default.removeItem(at: url)
        } catch {
            Issue.record(error, "Could not remove the temporary container root \(url.path)")
        }
    }

    /// Creates a container manager whose files live in the directory.
    ///
    /// It needs no kernel, vminit image, or vmnet: the kernel and initfs
    /// paths don't exist and are opened only when a VM starts, which no test
    /// does. It has no network.
    ///
    /// - Returns: A manager over an empty image store.
    /// - Throws: Containerization's error when the image store can't be
    ///   created.
    func createContainerManager() throws -> ContainerManager {
        try ContainerManager(
            kernel: Kernel(path: url.appending(path: "missing-kernel"), platform: .linuxArm),
            initfs: .block(format: "ext4", source: url.appending(path: "missing-initfs.ext4").path, destination: "/"),
            root: url
        )
    }
}
