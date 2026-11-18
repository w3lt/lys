import FluidAudio
import Foundation

/// Which child of voice's main task group ended.
private enum MainChild: Sendable {
    /// The model warm-up, after which voice keeps serving.
    case warmUp
    /// A server or the signal wait, whose end stops voice.
    case service
}

/// The speech models could not be loaded, so voice could never speak.
///
/// It ends ``serveVoice(loadModels:services:)``, so voice exits instead of
/// answering `503` for good, and the host reports it stopped.
struct ModelLoadError: Error, CustomStringConvertible {
    /// Why loading failed.
    let cause: any Error

    /// The message voice prints before it exits.
    var description: String { "could not load the speech models: \(cause)" }
}

/// Command-line entry point of voice.
@main
struct voice {
    /// Starts the speech socket server and the `/health` HTTP server, and
    /// loads the PocketTTS models in the background.
    ///
    /// The sockets serve at once; `/health` answers `503` and the speech
    /// socket refuses handshakes until the models are loaded, which happens
    /// once, here. voice stops on `SIGINT` or `SIGTERM`, or when a server
    /// stops. It prints the error and exits with status 1 when startup or a
    /// server fails, or when the models cannot be loaded.
    static func main() async {
        configureSpeechEngineLogging()
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
            try await serveVoice(
                loadModels: {
                    try await engine.loadModels()
                    print("voice: models ready")
                },
                services: [
                    { try await httpServer.start() },
                    { try await socketServer.start() },
                    { await waitForSignal(in: [SIGINT, SIGTERM]) },
                ]
            )
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

/// Keeps the logs in which FluidAudio quotes the text it speaks out of
/// voice's output.
///
/// FluidAudio logs every sentence a session receives at the info level, and
/// a debug build, such as the one `run.sh` and `pnpm dev` start, copies every
/// level to standard error. Its notices, warnings, and errors, such as a
/// download retry, still reach the log.
func configureSpeechEngineLogging() {
    AppLogger.minimumLevel = .notice
}

/// Runs voice's services while the models load, until a service ends.
///
/// The services and the model load start at once. Loading the models does
/// not end the run; the first service that ends or fails does, and so does a
/// failed load. The other children are cancelled, and have ended, before the
/// call returns or throws.
///
/// - Parameters:
///   - loadModels: Loads the speech models, once.
///   - services: The servers and the signal wait.
/// - Throws: ``ModelLoadError`` when `loadModels` fails, or the error of the
///   first service that fails.
func serveVoice(
    loadModels: @escaping @Sendable () async throws -> Void,
    services: [@Sendable () async throws -> Void]
) async throws {
    try await withThrowingTaskGroup(of: MainChild.self) { group in
        group.addTask {
            do {
                try await loadModels()
            } catch {
                throw ModelLoadError(cause: error)
            }
            return .warmUp
        }
        for service in services {
            group.addTask {
                try await service()
                return .service
            }
        }
        var ended = try await group.next()
        while ended == .warmUp {
            ended = try await group.next()
        }
        group.cancelAll()
    }
}
