import Foundation

/// Command-line entry point of voice.
@main
struct voice {
    /// Serves HTTP until `SIGINT` or `SIGTERM`.
    ///
    /// It prints the error and exits with status 1 when startup or serving
    /// fails.
    static func main() async {
        do {
            let router = try Router(routes: [.helloWorld])
            try await startWebServer(router: router)
        } catch {
            FileHandle.standardError.write(Data("voice: \(error)\n".utf8))
            exit(1)
        }
    }

    /// Serves HTTP with `router` until the server fails or voice receives
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
