import Foundation

/// Command-line entry point of vmo.
@main
struct vmo {
    /// Registers every endpoint and serves them on the local machine until the
    /// process ends.
    ///
    /// Prints the error to standard error and exits with status 1 when the
    /// routes are invalid or the server cannot listen.
    static func main() async {
        do {
            let router = try Router(routes: [.helloWorld, .dummyJSON])
            try await WebServer(router: router).start()
        } catch {
            FileHandle.standardError.write(Data("vmo: \(error)\n".utf8))
            exit(1)
        }
    }
}
