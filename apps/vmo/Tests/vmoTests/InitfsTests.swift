import Containerization
import ContainerizationArchive
import ContainerizationEXT4
import ContainerizationOCI
import Foundation
import SystemPackage
import Testing
@testable import vmo

/// Reference of the vminit image that vmo pins in these tests' stores.
private let vminitReference = "example.com/vminit:1"

/// Reference of the vminit image a later vmo pins instead.
private let laterVminitReference = "example.com/vminit:2"

/// Path, inside a fixture vminit's filesystem, of its only file. Its text
/// names the image, so a test can tell which vminit a filesystem came from.
private let vminitdPath = FilePath("/vminitd")

extension Trait where Self == ConditionTrait {
    /// Runs a test only when the current user isn't root. Root can read and
    /// write a file or directory whatever its permissions, so a test that
    /// makes one unreadable or read-only would prove nothing as root.
    fileprivate static var enabledUnlessRoot: Self {
        .enabled(if: getuid() != 0, "File permissions don't apply to root")
    }
}

/// One version of a file on disk: deleting and recreating the file changes
/// its number, and rewriting it changes its modification date.
private struct FileVersion: Equatable {
    /// The file system's number for the file.
    let fileNumber: UInt64

    /// When the file's contents last changed.
    let modificationDate: Date
}

/// Reads which version of `file` is on disk.
///
/// - Parameter file: An existing file.
/// - Returns: The file's number and modification date.
/// - Throws: The file system's error when `file` can't be read, or a test
///   failure when either value is missing.
private func readFileVersion(of file: URL) throws -> FileVersion {
    let values = try file.resourceValues(forKeys: [.fileIdentifierKey, .contentModificationDateKey])
    return FileVersion(
        fileNumber: try #require(values.fileIdentifier),
        modificationDate: try #require(values.contentModificationDate)
    )
}

/// Checks that ``ImageStore/loadInitfs(reference:)`` gives VMs the filesystem
/// of the vminit image the reference names, unpacking it only when the store
/// doesn't hold it unpacked from that image already.
///
/// The store is a real Containerization image store in a temporary directory.
/// Its vminit images are built by Containerization's `InitImage.create` from
/// a gzip tar with one file, `/vminitd`, and each unpacked filesystem is read
/// back with Containerization's ext4 reader. Nothing is pulled. Tests that
/// make a file or directory unreadable or read-only need a user whom file
/// permissions apply to, so they are skipped for root.
@Suite("Loading vminit's filesystem")
struct InitfsTests {
    /// Directory holding this test's image store and rootfs archives.
    private let temporaryRoot: TemporaryContainerRoot

    /// Content store of ``imageStore``, which `InitImage.create` writes the
    /// fixture images' blobs to.
    private let contentStore: LocalContentStore

    /// The store under test, empty at the start of each test.
    private let imageStore: ImageStore

    /// Creates this test's directory and an empty image store in it.
    ///
    /// - Throws: The file system's error when the directory or the store
    ///   can't be created.
    init() throws {
        temporaryRoot = try TemporaryContainerRoot()
        let storePath = temporaryRoot.url.appending(path: "store", directoryHint: .isDirectory)
        contentStore = try LocalContentStore(path: storePath.appending(path: "content", directoryHint: .isDirectory))
        imageStore = try ImageStore(path: storePath, contentStore: contentStore)
    }

    /// Stores a vminit image whose filesystem holds only `/vminitd`.
    ///
    /// - Parameter reference: Reference the store names the image by. The
    ///   file's text is the reference too.
    /// - Throws: The archive writer's error, or Containerization's when the
    ///   store refuses the image.
    private func saveVminitImage(reference: String) async throws {
        try await saveVminitImage(reference: reference, rootfs: try saveRootfsArchive(vminitdText: reference))
    }

    /// Writes a gzip tar whose only file is `vminitd`, as the rootfs of a
    /// vminit image.
    ///
    /// - Parameter vminitdText: Text of the file.
    /// - Returns: The archive, a new file in the test's directory.
    /// - Throws: The archive writer's error.
    private func saveRootfsArchive(vminitdText: String) throws -> URL {
        let rootfs = temporaryRoot.url.appending(path: "rootfs-\(UUID().uuidString).tar.gz")
        let writer = try ArchiveWriter(format: .paxRestricted, filter: .gzip, file: rootfs)
        let vminitd = Data(vminitdText.utf8)
        let entry = WriteEntry()
        entry.fileType = .regular
        entry.permissions = 0o755
        entry.path = "vminitd"
        entry.size = Int64(vminitd.count)
        try writer.writeEntry(entry: entry, data: vminitd)
        try writer.finishEncoding()
        return rootfs
    }

    /// Stores a vminit image whose single layer is `rootfs`, as it is.
    ///
    /// - Parameters:
    ///   - reference: Reference the store names the image by.
    ///   - rootfs: The layer's bytes, which unpacking reads as a gzip tar.
    /// - Throws: Containerization's error when the store refuses the image.
    private func saveVminitImage(reference: String, rootfs: URL) async throws {
        _ = try await InitImage.create(
            reference: reference,
            rootfs: rootfs,
            platform: SystemPlatform.linuxArm.ociPlatform(),
            imageStore: imageStore,
            contentStore: contentStore
        )
    }

    /// Reads which vminit the filesystem at `source` came from.
    ///
    /// - Parameter source: Path of an ext4 file unpacked from a fixture
    ///   vminit image.
    /// - Returns: The text of its `/vminitd`: the image's reference.
    /// - Throws: The ext4 reader's error when the file isn't an ext4
    ///   filesystem or has no `/vminitd`.
    private func readVminitd(fromInitfsAt source: String) throws -> String {
        let reader = try EXT4.EXT4Reader(blockDevice: FilePath(source))
        return String(decoding: try reader.readFile(at: vminitdPath), as: UTF8.self)
    }

    /// Verifies the first start: the store has no filesystem unpacked yet, so
    /// vminit is unpacked into the store's initfs file and mounted read-only
    /// as the VM's root.
    @Test("Unpacks the named vminit into a read-only root mount")
    func unpacksNamedVminit() async throws {
        try await saveVminitImage(reference: vminitReference)

        let initfs = try await imageStore.loadInitfs(reference: vminitReference)

        #expect(initfs.type == "ext4")
        #expect(initfs.source == imageStore.initfsFile.path)
        #expect(initfs.destination == "/")
        #expect(initfs.options == ["ro"])
        #expect(try readVminitd(fromInitfsAt: initfs.source) == vminitReference)
    }

    /// Verifies the fix for #218: once vmo names another vminit, VMs boot from
    /// that one, not from the filesystem the first one left.
    @Test("Unpacks the newly named vminit after the reference changes")
    func unpacksNewVminitAfterReferenceChanges() async throws {
        try await saveVminitImage(reference: vminitReference)
        try await saveVminitImage(reference: laterVminitReference)
        _ = try await imageStore.loadInitfs(reference: vminitReference)

        let initfs = try await imageStore.loadInitfs(reference: laterVminitReference)

        #expect(try readVminitd(fromInitfsAt: initfs.source) == laterVminitReference)
    }

    /// Verifies that a start whose vminit is already unpacked reuses that
    /// filesystem: the same files stay, neither recreated nor rewritten.
    @Test("Reuses the filesystem already unpacked from the named vminit")
    func reusesUnpackedVminit() async throws {
        try await saveVminitImage(reference: vminitReference)
        let firstInitfs = try await imageStore.loadInitfs(reference: vminitReference)
        let initfsVersion = try readFileVersion(of: imageStore.initfsFile)
        let recordVersion = try readFileVersion(of: imageStore.initfsVminitDigestFile)

        let initfs = try await imageStore.loadInitfs(reference: vminitReference)

        #expect(initfs.source == firstInitfs.source)
        #expect(initfs.options == ["ro"])
        #expect(try readFileVersion(of: imageStore.initfsFile) == initfsVersion)
        #expect(try readFileVersion(of: imageStore.initfsVminitDigestFile) == recordVersion)
        #expect(try readVminitd(fromInitfsAt: initfs.source) == vminitReference)
    }

    /// Verifies the first start after this fix on a Mac that ran vmo before:
    /// Containerization's reference-based `ContainerManager` init, which vmo
    /// used until then, left the store's initfs file without a record, and
    /// vmo now names another vminit.
    @Test("Unpacks the named vminit over a filesystem an earlier vmo left")
    func replacesFilesystemEarlierVmoLeft() async throws {
        try await saveVminitImage(reference: vminitReference)
        try await saveVminitImage(reference: laterVminitReference)
        _ = try await ContainerManager(
            kernel: Kernel(path: temporaryRoot.url.appending(path: "missing-kernel"), platform: .linuxArm),
            initfsReference: vminitReference,
            imageStore: imageStore
        )
        #expect(try readVminitd(fromInitfsAt: imageStore.initfsFile.path) == vminitReference)

        let initfs = try await imageStore.loadInitfs(reference: laterVminitReference)

        #expect(initfs.source == imageStore.initfsFile.path)
        #expect(try readVminitd(fromInitfsAt: initfs.source) == laterVminitReference)
    }

    /// Verifies that a record naming the vminit doesn't stand in for the
    /// filesystem itself: when the initfs file is gone, it is unpacked again.
    @Test("Unpacks again when the filesystem is missing although the record names the vminit")
    func unpacksAgainWhenFilesystemIsMissing() async throws {
        try await saveVminitImage(reference: vminitReference)
        _ = try await imageStore.loadInitfs(reference: vminitReference)
        try FileManager.default.removeItem(at: imageStore.initfsFile)

        let initfs = try await imageStore.loadInitfs(reference: vminitReference)

        #expect(try readVminitd(fromInitfsAt: initfs.source) == vminitReference)
    }

    /// Verifies that a failed unpack leaves no record, so the next load
    /// unpacks again rather than reusing whatever the failed one left.
    @Test("A failed unpack throws and leaves nothing a later load reuses")
    func leavesNothingAfterFailedUnpack() async throws {
        try await saveVminitImage(reference: vminitReference)
        // Cut in the middle of the gzip stream, as a layer whose download
        // ended early would be.
        let truncatedRootfs = try saveRootfsArchive(vminitdText: laterVminitReference)
        let archive = try Data(contentsOf: truncatedRootfs)
        try archive.prefix(archive.count / 2).write(to: truncatedRootfs)
        try await saveVminitImage(reference: laterVminitReference, rootfs: truncatedRootfs)
        _ = try await imageStore.loadInitfs(reference: vminitReference)

        await #expect(throws: ArchiveError.self) {
            try await imageStore.loadInitfs(reference: laterVminitReference)
        }

        #expect(!FileManager.default.fileExists(atPath: imageStore.initfsVminitDigestFile.path))
        let initfs = try await imageStore.loadInitfs(reference: vminitReference)
        #expect(try readVminitd(fromInitfsAt: initfs.source) == vminitReference)
    }

    /// Verifies that a record that exists but can't be read stops the load
    /// before anything is deleted, instead of counting as no record.
    @Test("An unreadable record throws and keeps the filesystem", .enabledUnlessRoot)
    func keepsFilesystemWhenRecordIsUnreadable() async throws {
        try await saveVminitImage(reference: vminitReference)
        try await saveVminitImage(reference: laterVminitReference)
        _ = try await imageStore.loadInitfs(reference: vminitReference)
        try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: imageStore.initfsVminitDigestFile.path)

        let error = await #expect(throws: CocoaError.self) {
            try await imageStore.loadInitfs(reference: laterVminitReference)
        }

        #expect(error?.code == .fileReadNoPermission)
        #expect(try readVminitd(fromInitfsAt: imageStore.initfsFile.path) == vminitReference)
    }

    /// Verifies that a deletion that fails for any reason but the file being
    /// missing stops the load, and that the filesystem and record it couldn't
    /// delete stay as they were.
    @Test("A failed deletion throws and keeps the filesystem and its record", .enabledUnlessRoot)
    func keepsFilesystemWhenDeletionFails() async throws {
        try await saveVminitImage(reference: vminitReference)
        try await saveVminitImage(reference: laterVminitReference)
        _ = try await imageStore.loadInitfs(reference: vminitReference)
        let vminitDigest = try await imageStore.get(reference: vminitReference).digest
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: imageStore.path.path)
        defer { restoreWritePermission(of: imageStore.path) }

        let error = await #expect(throws: CocoaError.self) {
            try await imageStore.loadInitfs(reference: laterVminitReference)
        }

        #expect(error?.code == .fileWriteNoPermission)
        #expect(try readVminitd(fromInitfsAt: imageStore.initfsFile.path) == vminitReference)
        #expect(try Data(contentsOf: imageStore.initfsVminitDigestFile) == Data(vminitDigest.utf8))
    }
}
