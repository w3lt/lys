import Foundation
import Network

final class WebServer: Sendable {
    private let port: NWEndpoint.Port
    private let host: NWEndpoint.Host

    init(port: NWEndpoint.Port = 8080, host: NWEndpoint.Host = "127.0.0.1") {
        self.host = host
        self.port = port
    }
    
    public func start() async throws {
        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true
        parameters.requiredLocalEndpoint = .hostPort(host: self.host, port: self.port)
        
        let listener = try NWListener(using: parameters, on: self.port)
        listener.stateUpdateHandler = { state in
            switch state {
            case .ready:
                print("WebServer listening on \(self.host):\(self.port)")
            case .failed(let error):
                print("Listener failed: \(error)")
            case .cancelled:
                print("Listener cancelled")
            default:
                break
            }
        }
        
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { return }
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    Task {
                        do {
                            try await self.handle(connection: connection)
                        } catch {
                            print("Connection Error: \(error)")
                            connection.cancel()
                        }
                    }
                case .failed(let error):
                    print("Connection failed: \(error)")
                    connection.cancel()
                case .cancelled:
                    break
                default:
                    break
                }
            }
            let queue = DispatchQueue(label: "WebServer.Connection", qos: .userInitiated)
            connection.start(queue: queue)
        }
        
        let queue = DispatchQueue(label: "WebServer.Listener", qos: .userInitiated)
        listener.start(queue: queue)
        
        defer { listener.cancel() }
        
        // Keep the listener alive until the task is cancelled
        while !Task.isCancelled {
            try await Task.sleep(nanoseconds: 1_000_000_000) // 1 second
        }
    }
    
    private func handle(connection: NWConnection) async throws {
        // Read until end of headers (CRLF CRLF)
        var buffer = Data()
        let headerTerminator = Data([13, 10, 13, 10]) // \r\n\r\n
        while true {
            let (data, isComplete) = try await receiveChunk(from: connection)
            if let data, !data.isEmpty {
                buffer.append(data)
            }
            if buffer.range(of: headerTerminator) != nil { break }
            if isComplete { break }
        }

        guard let headerRange = buffer.range(of: headerTerminator) else {
            try await sendResponse(
                connection: connection,
                statusCode: 400,
                reason: "Bad Request",
                headers: ["Content-Type": "text/plain; charset=utf-8"],
                body: Data("Bad Request\n".utf8)
            )
            connection.cancel()
            return
        }

        let headerData = buffer[..<headerRange.lowerBound]
        guard let headerString = String(data: headerData, encoding: .utf8) else {
            try await sendResponse(
                connection: connection,
                statusCode: 400,
                reason: "Bad Request",
                headers: ["Content-Type": "text/plain; charset=utf-8"],
                body: Data("Bad Request\n".utf8)
            )
            connection.cancel()
            return
        }

        let requestLine = headerString.split(separator: "\r\n", maxSplits: 1, omittingEmptySubsequences: false).first ?? ""
        let parts = requestLine.split(separator: " ")
        let method = parts.count > 0 ? String(parts[0]) : "GET"
        let path = parts.count > 1 ? String(parts[1]) : "/"

        if method != "GET" {
            try await sendResponse(
                connection: connection,
                statusCode: 405,
                reason: "Method Not Allowed",
                headers: ["Content-Type": "text/plain; charset=utf-8", "Allow": "GET"],
                body: Data("Method Not Allowed\n".utf8)
            )
            connection.cancel()
            return
        }

        switch path {
        case "/":
            let body = Data("Hello, world!\n".utf8)
            try await sendResponse(
                connection: connection,
                statusCode: 200,
                reason: "OK",
                headers: ["Content-Type": "text/plain; charset=utf-8"],
                body: body
            )
        case "/dummy-json":
            let jsonObject: [String: Any] = [
                "message": "This is dummy JSON",
                "items": [1, 2, 3],
                "success": true
            ]
            let body = try JSONSerialization.data(withJSONObject: jsonObject, options: [.prettyPrinted])
            try await sendResponse(
                connection: connection,
                statusCode: 200,
                reason: "OK",
                headers: ["Content-Type": "application/json; charset=utf-8"],
                body: body
            )
        default:
            let body = Data("Not Found\n".utf8)
            try await sendResponse(
                connection: connection,
                statusCode: 404,
                reason: "Not Found",
                headers: ["Content-Type": "text/plain; charset=utf-8"],
                body: body
            )
        }

        connection.cancel()
    }

    private func receiveChunk(from connection: NWConnection) async throws -> (Data?, Bool) {
        try await withCheckedThrowingContinuation { continuation in
            connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { data, _, isComplete, error in
                if let error = error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: (data, isComplete))
                }
            }
        }
    }

    private func sendResponse(
        connection: NWConnection,
        statusCode: Int,
        reason: String,
        headers: [String: String],
        body: Data
    ) async throws {
        var headerLines: [String] = []
        headerLines.append("HTTP/1.1 \(statusCode) \(reason)")
        var allHeaders = headers
        allHeaders["Content-Length"] = "\(body.count)"
        allHeaders["Connection"] = "close"

        for (key, value) in allHeaders {
            headerLines.append("\(key): \(value)")
        }
        headerLines.append("") // blank line
        let headerString = headerLines.joined(separator: "\r\n") + "\r\n"
        var responseData = Data(headerString.utf8)
        responseData.append(body)

        try await send(data: responseData, over: connection)
    }

    private func send(data: Data, over connection: NWConnection) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.send(content: data, completion: .contentProcessed { error in
                if let error = error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            })
        }
    }
}

