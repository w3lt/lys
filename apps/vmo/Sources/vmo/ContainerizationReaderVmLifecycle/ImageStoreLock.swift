import Foundation

/// Another process holds the image store that this vmo would use.
///
/// vmo prints it and exits, so its text says what the person can do.
struct ImageStoreInUseError: Error, CustomStringConvertible {
    /// Directory of the store.
    let storePath: URL

    var description: String {
        "another vmo uses the image store at \(storePath.path); stop it before starting this one"
    }
}

/// Name of the lock file in the image store's directory. Containerization
/// never lists or deletes a file at the store's root.
let imageStoreLockFileName = "vmo.lock"

/// Holds the image store at `storePath` for this process until it exits, so
/// that no second vmo pulls into the store or deletes from it meanwhile.
///
/// The hold is an exclusive `flock` on ``imageStoreLockFileName`` in the
/// store's directory, which is created when it's missing, as Containerization
/// does when it opens a store. The lock is taken without waiting: a second
/// vmo, such as one a Lys that died left running or one that `run.sh` starts
/// beside the desktop's, fails at once. Containerization takes no lock across
/// processes, so without this a second vmo could delete the blobs of a pull
/// the first one is running, or the reader image it is creating a VM from;
/// see ``ImageStore/deleteImages(except:)``.
///
/// The lock file stays open on purpose: closing it would release the lock,
/// and the kernel releases it when the process exits, however it exits. The
/// descriptor isn't inherited by the processes vmo starts, so none of them
/// keeps the store locked after vmo exits. The lock file stays in the store,
/// empty. A process holds a store at most once; a second call for the same
/// store fails like a second process.
///
/// - Parameter storePath: Directory of the image store.
/// - Throws: ``ImageStoreInUseError`` when another process holds the store.
///   The file system's error when the directory can't be created, and an
///   `NSPOSIXErrorDomain` error with the system's error number when the lock
///   file can't be opened or locked for another reason. Nothing is held
///   after a failure.
func holdImageStoreForProcess(at storePath: URL) throws {
    try FileManager.default.createDirectory(at: storePath, withIntermediateDirectories: true)
    let descriptor = open(storePath.appending(path: imageStoreLockFileName).path, O_RDONLY | O_CREAT | O_CLOEXEC, 0o644)
    guard descriptor != -1 else {
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
    guard flock(descriptor, LOCK_EX | LOCK_NB) != -1 else {
        let lockFailure = errno
        // The descriptor holds no lock, so a failure to close it loses
        // nothing. The lock's failure is the one the caller needs.
        close(descriptor)
        if lockFailure == EWOULDBLOCK {
            throw ImageStoreInUseError(storePath: storePath)
        }
        throw NSError(domain: NSPOSIXErrorDomain, code: Int(lockFailure))
    }
}
