import Foundation

/// Command-line entry point of vmo.
@main
struct vmo {
    static func main() async {
        do {
            let router = try Router(routes: [.helloWorld, .readPage])
            try await WebServer(router: router).start()
        } catch {
            FileHandle.standardError.write(Data("vmo: \(error)\n".utf8))
            exit(1)
        }
    }
}
