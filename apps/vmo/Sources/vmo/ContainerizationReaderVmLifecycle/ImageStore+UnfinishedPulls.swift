import Containerization
import Foundation

extension ImageStore {
    /// Directory where the store's content store keeps the files of each
    /// pull in progress, in a directory of their own, until the pull finishes
    /// and moves them to the blobs, or is cancelled and deletes them.
    ///
    /// It's `content/ingest` in the store, where `ImageStore(path:)` lays out
    /// its `LocalContentStore`.
    nonisolated var unfinishedPullsDirectory: URL {
        path.appending(path: "content/ingest", directoryHint: .isDirectory)
    }

    /// Deletes what the pulls that didn't finish left in the store.
    ///
    /// A vmo that exits during a pull, as on a `SIGTERM` while it starts,
    /// never cancels the pull, and Containerization deletes a pull's
    /// directory only when the pull finishes or is cancelled; the blob
    /// cleanup of ``deleteImages(except:)`` lists the blobs only. The store
    /// must be one that no other process writes, as for that method: this
    /// would delete the files of a pull another process is running.
    ///
    /// - Throws: The file system's error when ``unfinishedPullsDirectory``
    ///   can't be listed for another reason than being missing, or one of
    ///   its entries can't be deleted. What was deleted before the failure
    ///   stays deleted.
    func deleteUnfinishedPulls() throws {
        let fileManager = FileManager.default
        let unfinishedPulls: [URL]
        do {
            unfinishedPulls = try fileManager.contentsOfDirectory(at: unfinishedPullsDirectory, includingPropertiesForKeys: nil)
        } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
            // The store has no content store laid out, so no pull ran in it.
            return
        }
        for unfinishedPull in unfinishedPulls {
            try fileManager.removeItem(at: unfinishedPull)
        }
    }
}
