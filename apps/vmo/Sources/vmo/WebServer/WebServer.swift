import Network

final class WebServer: Sendable {
    private let port: NWEndpoint.Port
    private let host: NWEndpoint.Host

    init(port: NWEndpoint.Port = 8080, host: NWEndpoint.Host = "127.0.0.1") {
        self.host = host
        self.port = port
    }
    
    public func start() async throws {
        let parameters: NWParametersBuilder<TCP> = .parameters {
            TCP()
        }
            .localEndpoint(.hostPort(host: self.host, port: self.port))
        
        let listener = try NetworkListener(using: parameters)
        
        try await listener.run { connection in
            do {
                try await self.handleConnection(connection)
            } catch {
                print("Connection Error: \(error)")
            }
        }
    }
    
    private func handleConnection(
        _ connection: NetworkConnection<TCP>
    ) async throws {
        
    }
}
