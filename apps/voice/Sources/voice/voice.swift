import Foundation

/// Which child of voice's main task group ended.
private enum MainChild: Sendable {
    /// The model warm-up, after which voice keeps serving.
    case warmUp
    /// A server or the signal wait, whose end stops voice.
    case service
}

/// Command-line entry point of voice.
@main
struct voice {
    /// Starts the speech socket server and the `/health` HTTP server, and
    /// loads the PocketTTS models in the background.
    ///
    /// The sockets serve at once; `/health` answers `503` and the speech
    /// socket refuses handshakes until the models are loaded, which happens
    /// once, here. The servers keep serving after the warm-up ends, whether
    /// it loaded the models or failed. voice stops on `SIGINT` or `SIGTERM`,
    /// or when a server stops. It prints the error and exits with status 1
    /// when startup or a server fails.
    static func main() async {
        let modelsDirectory = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".lys", isDirectory: true)
            .appendingPathComponent("voice", isDirectory: true)
            .appendingPathComponent("models", isDirectory: true)
        let engine = PocketTtsSpeechEngine(
            modelsDirectory: modelsDirectory,
            clonedVoiceFile: findClonedVoiceURL()
        )
        do {
            let router = try Router(routes: [.buildHealth(isReady: { engine.isReady })])
            let httpServer = WebServer(router: router)
            let socketServer = SpeechSocketServer(engine: engine)
            try await withThrowingTaskGroup(of: MainChild.self) { group in
                group.addTask {
                    await loadEngineModels(engine)
                    return .warmUp
                }
                group.addTask {
                    try await httpServer.start()
                    return .service
                }
                group.addTask {
                    try await socketServer.start()
                    return .service
                }
                group.addTask {
                    await waitForSignal(in: [SIGINT, SIGTERM])
                    return .service
                }
                var ended = try await group.next()
                while ended == .warmUp {
                    ended = try await group.next()
                }
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
    private static func findClonedVoiceURL() -> URL? {
        let executable = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
        let candidate = executable.deletingLastPathComponent().appendingPathComponent("lys-voice.bin")
        return FileManager.default.fileExists(atPath: candidate.path) ? candidate : nil
    }
}

/// Warms the models, reporting failure without stopping the servers; the
/// health route and the speech socket stay unavailable until a later start
/// loads them.
///
/// - Parameter engine: Engine whose models are loaded.
private func loadEngineModels(_ engine: SpeechEngine) async {
    do {
        try await engine.loadModels()
        print("voice: models ready")
    } catch {
        FileHandle.standardError.write(Data("voice: could not load the speech models: \(error)\n".utf8))
    }
}
