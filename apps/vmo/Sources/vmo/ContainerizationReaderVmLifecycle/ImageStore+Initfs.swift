import Containerization
import Foundation

extension ImageStore {
    /// File in the store that holds vminit's filesystem, which every VM boots
    /// from, as ``loadInitfs(reference:)`` unpacks it.
    ///
    /// Containerization's reference-based `ContainerManager` init uses the
    /// same file, so a store that an earlier vmo used can hold one without
    /// ``initfsSourceFile``.
    nonisolated var initfsFile: URL {
        path.appending(path: "initfs.ext4")
    }

    /// File in the store that records which vminit image ``initfsFile`` was
    /// unpacked from: the image's digest, such as `sha256:` and 64 hex
    /// characters, as UTF-8 text.
    ///
    /// ``loadInitfs(reference:)`` writes it only once an unpack has completed.
    nonisolated var initfsSourceFile: URL {
        path.appending(path: "initfs.ext4.vminit-digest")
    }

    /// Returns vminit's filesystem for VMs to boot from, unpacked from the
    /// image `reference` names.
    ///
    /// The store pulls the image first when it doesn't hold it yet. vmo can't
    /// leave the filesystem to Containerization: its reference-based
    /// `ContainerManager` init unpacks only when ``initfsFile`` is missing,
    /// so after vmo names another vminit, VMs would keep booting from the
    /// first one the store held.
    ///
    /// ``initfsFile`` is reused only when ``initfsSourceFile`` holds the
    /// digest of the image `reference` names. Otherwise both are deleted, the
    /// image is unpacked, and the record is written last. So a filesystem an
    /// earlier vmo left, or one whose unpack failed or was interrupted, has no
    /// record and is unpacked again rather than reused.
    ///
    /// The store must be one that no other process writes, as for
    /// ``deleteImages(except:)``: a second vmo could replace the file while
    /// this one boots VMs from it.
    ///
    /// - Parameter reference: Reference of the vminit image, as the store
    ///   names it.
    /// - Returns: A read-only ext4 block mount of ``initfsFile`` at `/`.
    /// - Throws: Containerization's error when the image can't be pulled or
    ///   unpacked, or the file system's error when a file can't be deleted or
    ///   written, or when ``initfsFile`` exists and its record exists but
    ///   can't be read. The last stops the load before anything is deleted. A
    ///   load that fails after the deletion leaves no record, so the next load
    ///   unpacks again.
    func loadInitfs(reference: String) async throws -> Mount {
        // Pulls the image when the store doesn't hold it yet.
        _ = try await getInitImage(reference: reference)
        let vminit = try await get(reference: reference)
        if try isInitfsUnpacked(from: vminit.digest) {
            return .block(format: "ext4", source: initfsFile.path, destination: "/", options: ["ro"])
        }
        try deleteFileIfPresent(initfsSourceFile)
        try deleteFileIfPresent(initfsFile)
        let initfs = try await InitImage(image: vminit).initBlock(at: initfsFile, for: .linuxArm)
        try Data(vminit.digest.utf8).write(to: initfsSourceFile)
        return initfs
    }

    /// Answers whether ``initfsFile`` holds the filesystem of the image
    /// `vminitDigest` names: the file exists, and ``initfsSourceFile`` holds
    /// exactly that digest.
    ///
    /// - Parameter vminitDigest: Digest of the vminit image VMs must boot
    ///   from.
    /// - Returns: `false` when either file is missing, or the record holds
    ///   anything else, such as another image's digest or a write that didn't
    ///   finish.
    /// - Throws: The file system's error when ``initfsFile`` exists and the
    ///   record exists but can't be read.
    private func isInitfsUnpacked(from vminitDigest: String) throws -> Bool {
        guard FileManager.default.fileExists(atPath: initfsFile.path) else {
            return false
        }
        do {
            return try Data(contentsOf: initfsSourceFile) == Data(vminitDigest.utf8)
        } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
            // An earlier vmo left the filesystem, or the load that unpacked
            // it didn't finish.
            return false
        }
    }
}

/// Deletes `file` when it exists.
///
/// - Parameter file: The file to delete.
/// - Throws: The file system's error for any failure other than the file
///   being absent.
private func deleteFileIfPresent(_ file: URL) throws {
    do {
        try FileManager.default.removeItem(at: file)
    } catch let error as CocoaError where error.code == .fileNoSuchFile {
        // Already absent, which is all deleting it is for.
        return
    }
}
