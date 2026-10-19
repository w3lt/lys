import Foundation

/// Command-line entry point of vmo.
@main
struct vmo {
    /// Creates vmo's services, serves HTTP until `SIGINT` or `SIGTERM`, then
    /// closes the services.
    ///
    /// It prints the error and exits with status 1 when startup, serving, or
    /// closing fails.
    static func main() async {
        do {
            try await withServices { services in
                let router = try Router(routes: [.helloWorld, .health, .readPage(vmLifecycle: services.vmManager)])
                try await startWebServer(router: router)
            }
        } catch {
            FileHandle.standardError.write(Data("vmo: \(error)\n".utf8))
            exit(1)
        }
    }

    /// Serves HTTP with `router` until the server fails or vmo receives
    /// `SIGINT` or `SIGTERM`.
    ///
    /// A signal cancels the server, which returns once its open connections
    /// have ended. A second signal after that has its usual effect.
    ///
    /// - Parameter router: Routes that answer requests.
    /// - Throws: The server's error when its listener fails.
    private static func startWebServer(router: Router) async throws {
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask { try await WebServer(router: router).start() }
            group.addTask { await waitForSignal(in: [SIGINT, SIGTERM]) }
            _ = try await group.next()
            group.cancelAll()
        }
    }
}
