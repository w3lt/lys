import Containerization
import ContainerizationError
import CryptoKit
import Foundation
import Testing
@testable import vmo

/// Reference of vminit in these tests' stores.
private let vminitReference = "example.com/vminit:2"

/// Reference of the reader image in these tests' stores: the tag a pull moves.
private let readerReference = "example.com/reader:latest"

/// An image to store: a config and its layers, each a short text that becomes
/// one blob. Two images with an equal text share that blob.
private struct FixtureImage {
    /// Reference the store names the image by.
    let reference: String
    /// Text of the config blob. Distinct per image, so each has its own.
    let configText: String
    /// Texts of the layer blobs, in order.
    let layerTexts: [String]
}

/// Descriptor of one blob in an OCI image layout, encoded as the OCI image
/// specification defines it.
private struct LayoutDescriptor: Encodable {
    /// Media type of the blob.
    let mediaType: String
    /// `sha256:` digest of the blob's bytes.
    let digest: String
    /// Size of the blob in bytes.
    let size: Int
    /// Platform the blob is for, on a manifest that an index lists.
    var platform: [String: String]?
    /// Annotations, such as the image name on an entry of the layout's index.
    var annotations: [String: String]?
}

/// An image manifest, encoded as the OCI image specification defines it.
private struct LayoutManifest: Encodable {
    /// Version of the manifest format.
    let schemaVersion = 2
    /// Media type of an OCI image manifest.
    let mediaType = "application/vnd.oci.image.manifest.v1+json"
    /// The image's config blob.
    let config: LayoutDescriptor
    /// The image's layer blobs, in order.
    let layers: [LayoutDescriptor]
}

/// An image index, encoded as the OCI image specification defines it.
private struct LayoutIndex: Encodable {
    /// Version of the index format.
    let schemaVersion = 2
    /// Media type of an OCI image index.
    let mediaType = "application/vnd.oci.image.index.v1+json"
    /// Manifests or indexes the index lists.
    let manifests: [LayoutDescriptor]
}

/// Saves `data` as a blob of the OCI image layout at `layout`.
///
/// - Parameters:
///   - data: The blob's bytes.
///   - mediaType: Media type its descriptor gives.
///   - layout: Directory of the layout, which has `blobs/sha256`.
/// - Returns: The descriptor that names the blob.
/// - Throws: The file system's error when the blob can't be written.
private func saveBlob(_ data: Data, mediaType: String, in layout: URL) throws -> LayoutDescriptor {
    let hexDigest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    try data.write(to: layout.appending(path: "blobs/sha256/\(hexDigest)"))
    return LayoutDescriptor(mediaType: mediaType, digest: "sha256:\(hexDigest)", size: data.count)
}

/// Saves an OCI image layout at `layout` that holds `image` under its
/// reference, as an index for `linux/arm64` that lists one manifest.
///
/// - Parameters:
///   - image: The image to save.
///   - layout: A directory that doesn't exist yet.
/// - Throws: The file system's error when a file can't be written.
private func saveLayout(of image: FixtureImage, at layout: URL) throws {
    try FileManager.default.createDirectory(at: layout.appending(path: "blobs/sha256"), withIntermediateDirectories: true)
    let config = try saveBlob(Data(image.configText.utf8), mediaType: "application/vnd.oci.image.config.v1+json", in: layout)
    let layers = try image.layerTexts.map { layerText in
        try saveBlob(Data(layerText.utf8), mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", in: layout)
    }
    let manifestData = try JSONEncoder().encode(LayoutManifest(config: config, layers: layers))
    var manifest = try saveBlob(manifestData, mediaType: "application/vnd.oci.image.manifest.v1+json", in: layout)
    manifest.platform = ["architecture": "arm64", "os": "linux"]
    let indexData = try JSONEncoder().encode(LayoutIndex(manifests: [manifest]))
    var index = try saveBlob(indexData, mediaType: "application/vnd.oci.image.index.v1+json", in: layout)
    index.annotations = ["com.apple.containerization.image.name": image.reference]
    try JSONEncoder().encode(LayoutIndex(manifests: [index])).write(to: layout.appending(path: "index.json"))
    try Data(#"{"imageLayoutVersion":"1.0.0"}"#.utf8).write(to: layout.appending(path: "oci-layout"))
}

/// Lists the digests that `image` uses whose blob its store doesn't hold.
///
/// - Parameter image: An image the store names.
/// - Returns: The missing digests; empty when the image's content is complete.
/// - Throws: Containerization's error when the image's index or a manifest
///   can't be read, or a blob lookup fails for another reason than absence.
private func listMissingDigests(of image: Image) async throws -> [String] {
    var missingDigests: [String] = []
    for digest in try await image.referencedDigests() {
        if try await !hasContent(image, digest: digest) {
            missingDigests.append(digest)
        }
    }
    return missingDigests
}

/// Answers whether the store of `image` holds the blob `digest` names.
///
/// - Parameters:
///   - image: An image that uses `digest`.
///   - digest: Digest of one of the image's blobs.
/// - Returns: `false` when the store reports the blob as not found.
/// - Throws: Containerization's error for any other failure.
private func hasContent(_ image: Image, digest: String) async throws -> Bool {
    do {
        _ = try await image.getContent(digest: digest)
        return true
    } catch let error as ContainerizationError where error.isCode(.notFound) {
        return false
    }
}

/// Makes `directory` writable again, as a test that made it read-only must
/// before ``TemporaryContainerRoot`` removes it.
///
/// - Parameter directory: A directory the test made read-only. A test issue
///   is recorded when its permissions can't be set.
private func restoreWritePermission(of directory: URL) {
    do {
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: directory.path)
    } catch {
        Issue.record(error, "Could not make \(directory.path) writable again")
    }
}

/// Checks that ``ImageStore/deleteImages(except:)`` leaves a store holding
/// the kept images and nothing else, and what it leaves when deleting fails.
///
/// Images enter each store through `ImageStore.load(from:)`, which stores an
/// image the way a pull does: it ingests the blobs, then sets the reference,
/// moving it when the store already names another image by it. The store is
/// a real Containerization image store in a temporary directory. Tests that
/// make deleting fail make a directory of the store read-only, so they need a
/// user whom file permissions apply to, not root.
@Suite("Deleting unused images")
struct UnusedImagesTests {
    /// Directory holding this test's image store and image layouts.
    private let temporaryRoot: TemporaryContainerRoot

    /// The store under test, empty at the start of each test.
    private let imageStore: ImageStore

    /// Creates this test's directory and an empty image store in it.
    ///
    /// - Throws: The file system's error when the directory or the store
    ///   can't be created.
    init() throws {
        temporaryRoot = try TemporaryContainerRoot()
        imageStore = try ImageStore(path: temporaryRoot.url.appending(path: "store", directoryHint: .isDirectory))
    }

    /// Stores `image` the way a pull does, from an OCI layout of its own.
    ///
    /// - Parameter image: The image to store.
    /// - Returns: The stored image.
    /// - Throws: The file system's error, or Containerization's when the
    ///   store refuses the image.
    private func saveImage(_ image: FixtureImage) async throws -> Image {
        let layout = temporaryRoot.url.appending(path: "layout-\(UUID().uuidString)", directoryHint: .isDirectory)
        try saveLayout(of: image, at: layout)
        let loadedImages = try await imageStore.load(from: layout)
        return try #require(loadedImages.first)
    }

    /// Lists the store's references with the digest of the image each names.
    ///
    /// - Returns: The digest of each named image, by reference.
    /// - Throws: Containerization's error when the store can't list its images.
    private func listImageDigests() async throws -> [String: String] {
        Dictionary(uniqueKeysWithValues: try await imageStore.list().map { ($0.reference, $0.digest) })
    }

    /// Verifies the fix for #213: after the reader's tag moves to a new image,
    /// the image it named before is deleted, while vminit, the new image, and
    /// the layer the two reader images share stay.
    @Test("Deletes the image a moved tag named before and keeps the named images")
    func deletesImageOfMovedTag() async throws {
        let vminit = try await saveImage(FixtureImage(reference: vminitReference, configText: "vminit config", layerTexts: ["vminit layer"]))
        _ = try await saveImage(FixtureImage(reference: readerReference, configText: "old reader config", layerTexts: ["base layer", "old reader layer"]))
        let newReader = try await saveImage(FixtureImage(reference: readerReference, configText: "new reader config", layerTexts: ["base layer", "new reader layer"]))
        #expect(try await imageStore.calculateOrphanedBlobsSize() > 0)

        try await imageStore.deleteImages(except: [vminitReference, readerReference])

        #expect(try await imageStore.calculateOrphanedBlobsSize() == 0)
        #expect(try await listImageDigests() == [vminitReference: vminit.digest, readerReference: newReader.digest])
        #expect(try await listMissingDigests(of: vminit).isEmpty)
        #expect(try await listMissingDigests(of: newReader).isEmpty)
    }

    /// Verifies that an image no kept reference names, such as the vminit of
    /// an earlier Containerization version, is deleted, but not a layer that a
    /// kept image shares with it.
    @Test("Deletes an image whose reference isn't kept, but not a layer a kept image shares")
    func deletesImageNotKept() async throws {
        _ = try await saveImage(FixtureImage(reference: "example.com/vminit:1", configText: "old vminit config", layerTexts: ["vminit base layer", "old vminit layer"]))
        let vminit = try await saveImage(FixtureImage(reference: vminitReference, configText: "vminit config", layerTexts: ["vminit base layer", "vminit layer"]))
        let reader = try await saveImage(FixtureImage(reference: readerReference, configText: "reader config", layerTexts: ["reader layer"]))

        try await imageStore.deleteImages(except: [vminitReference, readerReference])

        #expect(try await imageStore.calculateOrphanedBlobsSize() == 0)
        #expect(try await listImageDigests() == [vminitReference: vminit.digest, readerReference: reader.digest])
        #expect(try await listMissingDigests(of: vminit).isEmpty)
    }

    /// Verifies the usual start, when `latest` hasn't moved: every image is
    /// kept, so nothing is deleted.
    @Test("Deletes nothing when every image is kept")
    func keepsEverythingKept() async throws {
        let vminit = try await saveImage(FixtureImage(reference: vminitReference, configText: "vminit config", layerTexts: ["vminit layer"]))
        let reader = try await saveImage(FixtureImage(reference: readerReference, configText: "reader config", layerTexts: ["reader layer"]))

        try await imageStore.deleteImages(except: [vminitReference, readerReference])

        #expect(try await listImageDigests() == [vminitReference: vminit.digest, readerReference: reader.digest])
        #expect(try await listMissingDigests(of: vminit).isEmpty)
        #expect(try await listMissingDigests(of: reader).isEmpty)
    }

    /// Verifies that a store whose image list can't be read reports the
    /// failure and loses nothing, not even the blobs of an image a moved tag
    /// left.
    @Test("Throws and deletes nothing when the store can't list its images")
    func deletesNothingWhenListingFails() async throws {
        _ = try await saveImage(FixtureImage(reference: readerReference, configText: "old reader config", layerTexts: ["old reader layer"]))
        _ = try await saveImage(FixtureImage(reference: readerReference, configText: "new reader config", layerTexts: ["new reader layer"]))
        let orphanedBytes = try await imageStore.calculateOrphanedBlobsSize()
        // Containerization keeps the store's list of images in `state.json`.
        let stateFile = imageStore.path.appending(path: "state.json")
        let state = try Data(contentsOf: stateFile)
        try Data("not JSON".utf8).write(to: stateFile)

        let error = await #expect(throws: ContainerizationError.self) {
            try await imageStore.deleteImages(except: [readerReference])
        }

        #expect(error?.isCode(.internalError) == true)
        try state.write(to: stateFile)
        #expect(try await imageStore.calculateOrphanedBlobsSize() == orphanedBytes)
    }

    /// Verifies that when deleting blobs fails after the unused images are
    /// deleted, the failure is reported, those images stay deleted, and the
    /// kept images keep every blob they use.
    @Test("A failed blob deletion throws and keeps the deleted images deleted")
    func keepsDeletedImagesWhenBlobDeletionFails() async throws {
        let vminit = try await saveImage(FixtureImage(reference: vminitReference, configText: "vminit config", layerTexts: ["vminit layer"]))
        _ = try await saveImage(FixtureImage(reference: readerReference, configText: "old reader config", layerTexts: ["old reader layer"]))
        let newReader = try await saveImage(FixtureImage(reference: readerReference, configText: "new reader config", layerTexts: ["new reader layer"]))
        _ = try await saveImage(FixtureImage(reference: "example.com/other:1", configText: "other config", layerTexts: ["other layer"]))
        // Containerization keeps every blob as a file in this directory, and
        // no file can be removed from a read-only directory.
        let blobs = imageStore.path.appending(path: "content/blobs/sha256", directoryHint: .isDirectory)
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: blobs.path)
        defer { restoreWritePermission(of: blobs) }

        let error = await #expect(throws: CocoaError.self) {
            try await imageStore.deleteImages(except: [vminitReference, readerReference])
        }

        #expect(error?.code == .fileWriteNoPermission)
        #expect(try await listImageDigests() == [vminitReference: vminit.digest, readerReference: newReader.digest])
        #expect(try await imageStore.calculateOrphanedBlobsSize() > 0)
        #expect(try await listMissingDigests(of: vminit).isEmpty)
        #expect(try await listMissingDigests(of: newReader).isEmpty)
    }

    /// Verifies that when deleting an unused image fails, the failure is
    /// reported before any blob is deleted, so the store keeps its images and
    /// the blobs no image uses.
    @Test("A failed image deletion throws before any blob is deleted")
    func deletesNoBlobWhenImageDeletionFails() async throws {
        _ = try await saveImage(FixtureImage(reference: readerReference, configText: "old reader config", layerTexts: ["old reader layer"]))
        let reader = try await saveImage(FixtureImage(reference: readerReference, configText: "new reader config", layerTexts: ["new reader layer"]))
        let other = try await saveImage(FixtureImage(reference: "example.com/other:1", configText: "other config", layerTexts: ["other layer"]))
        let orphanedBytes = try await imageStore.calculateOrphanedBlobsSize()
        #expect(orphanedBytes > 0)
        // Deleting an image rewrites `state.json` atomically, through a new
        // file in the store's directory, which a read-only directory refuses.
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: imageStore.path.path)
        defer { restoreWritePermission(of: imageStore.path) }

        let error = await #expect(throws: CocoaError.self) {
            try await imageStore.deleteImages(except: [readerReference])
        }

        #expect(error?.code == .fileWriteNoPermission)
        #expect(try await listImageDigests() == ["example.com/other:1": other.digest, readerReference: reader.digest])
        #expect(try await imageStore.calculateOrphanedBlobsSize() == orphanedBytes)
    }
}
