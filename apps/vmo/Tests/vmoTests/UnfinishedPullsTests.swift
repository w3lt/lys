import Containerization
import ContainerizationOCI
import Foundation
import Testing
@testable import vmo

/// Checks that ``ImageStore/deleteUnfinishedPulls()`` leaves a store without
/// the files of the pulls that didn't finish, and changes nothing else.
///
/// The store is a real Containerization image store in a temporary
/// directory, with the `LocalContentStore` that `ImageStore(path:)` lays out.
/// Each unfinished pull is an ingest session of that content store that is
/// neither completed nor cancelled, as a pull that vmo exited during leaves
/// it. The test that makes deleting fail makes a directory read-only, so it
/// is skipped for root.
@Suite("Deleting unfinished pulls")
struct UnfinishedPullsTests {
    /// Directory holding this test's image store.
    private let temporaryRoot: TemporaryContainerRoot

    /// Content store of ``imageStore``, which starts the unfinished pulls.
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

    /// Starts a pull that never finishes: an ingest session holding a
    /// finished layer and the temporary file of an unfinished one.
    ///
    /// - Returns: The pull's directory.
    /// - Throws: Containerization's error when the session can't start, or
    ///   the file system's when a file can't be written.
    private func startUnfinishedPull() async throws -> URL {
        let (_, pullDirectory) = try await contentStore.newIngestSession()
        try Data("finished layer".utf8).write(to: pullDirectory.appending(path: "sha256-finished"))
        try Data("unfinished layer".utf8).write(to: pullDirectory.appending(path: ".tmp-unfinished"))
        return pullDirectory
    }

    /// Verifies the fix for #217: every unfinished pull's directory goes,
    /// while the blobs, the image list, and the pulls directory itself stay.
    @Test("Deletes every unfinished pull and keeps the blobs and the pulls directory")
    func deletesUnfinishedPulls() async throws {
        let firstPull = try await startUnfinishedPull()
        let secondPull = try await startUnfinishedPull()
        #expect(firstPull.path.hasPrefix(imageStore.unfinishedPullsDirectory.path + "/"))
        let blob = imageStore.path.appending(path: "content/blobs/sha256/" + String(repeating: "a", count: 64))
        try Data("blob".utf8).write(to: blob)

        try await imageStore.deleteUnfinishedPulls()

        #expect(!FileManager.default.fileExists(atPath: firstPull.path))
        #expect(!FileManager.default.fileExists(atPath: secondPull.path))
        #expect(try FileManager.default.contentsOfDirectory(atPath: imageStore.unfinishedPullsDirectory.path).isEmpty)
        #expect(try Data(contentsOf: blob) == Data("blob".utf8))
        #expect(try await imageStore.list().isEmpty)
    }

    /// Verifies the usual start, when every earlier pull finished, and a
    /// store whose content store isn't laid out: nothing to delete, no error.
    @Test("Does nothing without an unfinished pull, or without a pulls directory")
    func doesNothingWithoutUnfinishedPulls() async throws {
        try await imageStore.deleteUnfinishedPulls()
        #expect(try FileManager.default.contentsOfDirectory(atPath: imageStore.unfinishedPullsDirectory.path).isEmpty)

        try FileManager.default.removeItem(at: imageStore.path.appending(path: "content", directoryHint: .isDirectory))
        try await imageStore.deleteUnfinishedPulls()
        #expect(!FileManager.default.fileExists(atPath: imageStore.unfinishedPullsDirectory.path))
    }

    /// Verifies that a pull whose files can't be deleted reports the failure
    /// and keeps its files.
    @Test("Throws and keeps the pull's files when they can't be deleted", .enabledUnlessRoot)
    func throwsWhenDeletionFails() async throws {
        let pull = try await startUnfinishedPull()
        // No file can be removed from a read-only directory.
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: pull.path)
        defer { restoreWritePermission(of: pull) }

        let error = await #expect(throws: CocoaError.self) {
            try await imageStore.deleteUnfinishedPulls()
        }

        #expect(error?.code == .fileWriteNoPermission)
        #expect(try Set(FileManager.default.contentsOfDirectory(atPath: pull.path)) == ["sha256-finished", ".tmp-unfinished"])
    }

    /// Verifies that a pulls directory that can't be listed for another
    /// reason than being missing reports the failure.
    @Test("Throws when the pulls directory can't be listed")
    func throwsWhenListingFails() async throws {
        try FileManager.default.removeItem(at: imageStore.unfinishedPullsDirectory)
        try Data().write(to: imageStore.unfinishedPullsDirectory)

        let error = await #expect(throws: CocoaError.self) {
            try await imageStore.deleteUnfinishedPulls()
        }

        #expect(error?.code != .fileReadNoSuchFile)
    }
}
