import Foundation

/// Command-line entry point of voice.
@main
struct voice {
    /// Starts the speech socket server and the `/health` HTTP server, then
    /// loads the PocketTTS models in the background.
    ///
    /// The sockets serve at once; `/health` answers `503` and the speech
    /// socket refuses handshakes until the models are loaded, which happens
    /// once, here. It prints the error and exits with status 1 when startup
    /// fails.
    static func main() async {
        let modelsDirectory = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".lys", isDirectory: true)
            .appendingPathComponent("voice", isDirectory: true)
            .appendingPathComponent("models", isDirectory: true)
        let clonedVoiceFile = clonedVoiceURL()
        let engine = PocketTtsSpeechEngine(
            modelsDirectory: modelsDirectory,
            clonedVoiceFile: clonedVoiceFile
        )
        let ready = SpeechEngineBox(engine: engine)

        let router = (try? Router(routes: [.health(isReady: ready.isReady)])).map { $0 }
        do {
            guard let router else {
                FileHandle.standardError.write(Data("voice: could not register routes\n".utf8))
                exit(1)
            }
            let httpServer = WebServer(router: router)
            let socketServer = SpeechSocketServer(engine: engine)
            try await withThrowingTaskGroup(of: Void.self) { group in
                group.addTask { await warmModels(engine) }
                group.addTask { try await httpServer.start() }
                group.addTask { try await socketServer.start() }
                group.addTask { await waitForSignal(in: [SIGINT, SIGTERM]) }
                _ = try await group.next()
                group.cancelAll()
            }
        } catch {
            FileHandle.standardError.write(Data("voice: \(error)\n".utf8))
            exit(1)
        }
    }

    /// Locates the cloned voice shipped next to the executable, when one is.
    ///
    /// A cloned voice, produced once with
    /// `PocketTtsManager.cloneVoiceToFile`, is loaded at startup instead of
    /// the preset `alba`. The file sits next to the `voice` binary, so an
    /// installed release carries it when Lys ships one.
    private static func clonedVoiceURL() -> URL? {
        let executable = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
        let candidate = executable.deletingLastPathComponent().appendingPathComponent("lys-voice.bin")
        return FileManager.default.fileExists(atPath: candidate.path) ? candidate : nil
    }
}

/// Sendable view of the engine's readiness flag for the `/health` route.
private final class SpeechEngineBox: @unchecked Sendable {
    private let engine: SpeechEngine

    init(engine: SpeechEngine) {
        self.engine = engine
    }

    /// Whether the models are loaded.
    func isReady() -> Bool {
        engine.isReady
    }
}

/// Warms the models, reporting failure without stopping the servers; the
/// health route and the speech socket stay unavailable until a later start
/// loads them.
private func warmModels(_ engine: SpeechEngine) async {
    do {
        try await engine.warmUp()
        print("voice: models ready")
    } catch {
        FileHandle.standardError.write(Data("voice: could not load the speech models: \(error)\n".utf8))
    }
}
