import Foundation
import Testing
@testable import vmo

/// Checks that ``holdImageStoreForProcess(at:)`` lets one holder use a store
/// at a time.
///
/// A `flock` belongs to an open file, not to a process, so a second hold
/// taken in this process on the same store meets the first one as a second
/// vmo would. Each test holds a store of its own for the rest of the test
/// process, as vmo holds its store until it exits. The test that makes
/// holding fail makes a directory read-only, so it is skipped for root.
@Suite("Holding the image store")
struct ImageStoreLockTests {
    /// Directory holding this test's store.
    private let temporaryRoot: TemporaryContainerRoot

    /// The store to hold, which doesn't exist at the start of each test.
    private let storePath: URL

    /// Creates this test's directory.
    ///
    /// - Throws: The file system's error when the directory can't be created.
    init() throws {
        temporaryRoot = try TemporaryContainerRoot()
        storePath = temporaryRoot.url.appending(path: "store", directoryHint: .isDirectory)
    }

    /// Verifies the fix for #216: while one holder has the store, a second
    /// one fails at once with an error that names the store.
    @Test("Creates the store and its lock file, and refuses a second hold while the first lasts")
    func refusesSecondHold() throws {
        try holdImageStoreForProcess(at: storePath)
        #expect(FileManager.default.fileExists(atPath: storePath.appending(path: imageStoreLockFileName).path))

        let error = #expect(throws: ImageStoreInUseError.self) {
            try holdImageStoreForProcess(at: storePath)
        }

        #expect(error?.storePath == storePath)
        #expect(error?.description.contains(storePath.path) == true)
    }

    /// Verifies that the hold is the store's, not the user's: another store
    /// can be held at the same time.
    @Test("Holds stores at different paths independently")
    func holdsStoresIndependently() throws {
        try holdImageStoreForProcess(at: storePath)

        #expect(throws: Never.self) {
            try holdImageStoreForProcess(at: temporaryRoot.url.appending(path: "other-store", directoryHint: .isDirectory))
        }
    }

    /// Verifies that a store whose directory can't be created reports the
    /// file system's failure.
    @Test("Throws the file system's error when the store can't be created", .enabledUnlessRoot)
    func throwsWhenStoreCannotBeCreated() throws {
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: temporaryRoot.url.path)
        defer { restoreWritePermission(of: temporaryRoot.url) }

        let error = #expect(throws: CocoaError.self) {
            try holdImageStoreForProcess(at: storePath)
        }

        #expect(error?.code == .fileWriteNoPermission)
    }
}
