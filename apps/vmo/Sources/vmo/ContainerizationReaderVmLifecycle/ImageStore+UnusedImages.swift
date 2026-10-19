import Containerization

extension ImageStore {
    /// Deletes every image in the store other than those `usedReferences`
    /// name, then every blob that no remaining image uses.
    ///
    /// Those blobs include what an image left when its tag moved to another
    /// image, such as the reader image that `latest` named before the last
    /// pull. A blob that a remaining image shares with a deleted one stays.
    ///
    /// The store must be one that no other process writes. Containerization
    /// takes no lock across processes, so in a shared store this would delete
    /// other tools' images, and could delete a blob that another process's
    /// pull has just found in the store and is about to name.
    ///
    /// - Parameter usedReferences: References of the images to keep, as the
    ///   store names them. A reference the store doesn't hold is ignored.
    /// - Throws: Containerization's error when the store can't list its
    ///   images, delete one of them, or delete blobs. What was deleted before
    ///   the failure stays deleted; no blob is deleted before every unused
    ///   image is.
    func deleteImages(except usedReferences: Set<String>) async throws {
        for image in try await list() where !usedReferences.contains(image.reference) {
            try await delete(reference: image.reference)
        }
        try await cleanUpOrphanedBlobs()
    }
}
