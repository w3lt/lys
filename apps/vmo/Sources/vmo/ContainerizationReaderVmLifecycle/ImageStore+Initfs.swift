import Containerization
import Foundation

extension ImageStore {
    /// File in the store that holds vminit's filesystem, which every VM boots
    /// from, as ``loadInitfs(reference:)`` unpacks it.
    ///
    /// Containerization's reference-based `ContainerManager` init uses the
    /// same file, so a store that an earlier vmo used can hold one without
    /// ``initfsVminitDigestFile``.
    nonisolated var initfsFile: URL {
        path.appending(path: "initfs.ext4")
    }

    /// File in the store that records which vminit image ``initfsFile`` was
    /// unpacked from: the image's digest, such as `sha256:` and 64 hex
    /// characters, as UTF-8 text.
    ///
    /// ``loadInitfs(reference:)`` writes it only once an unpack has completed.
    nonisolated var initfsVminitDigestFile: URL {
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
    /// ``initfsFile`` is reused only when ``initfsVminitDigestFile`` holds
    /// the digest of the image `reference` names. Otherwise both are deleted,
    /// the image is unpacked, and the record is written last. So a filesystem
    /// an earlier vmo left, or one whose unpack failed or was interrupted, has
    /// no record and is unpacked again rather than reused.
    ///
    /// The store must be one that no other process writes, as for
    /// ``deleteImages(except:)``: a second vmo could replace the file while
    /// this one boots VMs from it.
    ///
    /// - Parameter reference: Reference of the vminit image, as the store
    ///   names it.
    /// - Returns: A read-only ext4 block mount of ``initfsFile`` at `/`.
    /// - Throws: Containerization's error when the image can't be pulled or
    ///   unpacked, or the file system's error when either file can't be
    ///   checked or read for any reason but being missing, or can't be deleted
    ///   or written. A failed check or read stops the load before anything is
    ///   deleted. A load that fails after the deletion leaves no record, so the
    ///   next load unpacks again.
    func loadInitfs(reference: String) async throws -> Mount {
        let vminit = try await get(reference: reference, pull: true)
        if try findUnpackedVminitDigest() == vminit.digest {
            return .block(format: "ext4", source: initfsFile.path, destination: "/", options: ["ro"])
        }
        try deleteUnpackedInitfs()
        let initfs = try await InitImage(image: vminit).initBlock(at: initfsFile, for: .linuxArm)
        try saveUnpackedVminitDigest(vminit.digest)
        return initfs
    }

    /// Returns which vminit image ``initfsFile`` was unpacked from, as its
    /// record names it.
    ///
    /// - Returns: The text ``initfsVminitDigestFile`` holds, or `nil` when it
    ///   or ``initfsFile`` is missing. A record whose write didn't finish
    ///   holds part of a digest or nothing, which names no image.
    /// - Throws: The file system's error when either file can't be checked or
    ///   read for any reason but being missing. A failed check doesn't show
    ///   that a file is missing.
    private func findUnpackedVminitDigest() throws -> String? {
        do {
            // Unlike `fileExists(atPath:)`, which answers false whenever it
            // can't tell, this throws `.fileReadNoSuchFile` only when the file
            // is missing, and another error for any other failure.
            guard try initfsFile.checkResourceIsReachable() else {
                return nil
            }
            return String(decoding: try Data(contentsOf: initfsVminitDigestFile), as: UTF8.self)
        } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
            // Nothing is unpacked yet, an earlier vmo left the filesystem, or
            // the load that unpacked it didn't finish.
            return nil
        }
    }

    /// Deletes ``initfsFile`` and its record, so that vminit can be unpacked
    /// again. The record goes first, so a filesystem is never left with a
    /// record that no longer describes it.
    ///
    /// - Throws: The file system's error when a file exists but can't be
    ///   deleted. Nothing after the failure is deleted.
    private func deleteUnpackedInitfs() throws {
        try deleteFileIfPresent(initfsVminitDigestFile)
        try deleteFileIfPresent(initfsFile)
    }

    /// Records that ``initfsFile`` holds the filesystem of the vminit image
    /// `vminitDigest` names.
    ///
    /// - Parameter vminitDigest: Digest of the vminit image that
    ///   ``initfsFile`` was just unpacked from.
    /// - Throws: The file system's error when the record can't be written.
    ///   The store then holds no record that names the image, so the next
    ///   load unpacks again.
    private func saveUnpackedVminitDigest(_ vminitDigest: String) throws {
        try Data(vminitDigest.utf8).write(to: initfsVminitDigestFile)
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
