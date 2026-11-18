import Foundation
import Network
import Testing
@testable import voice

/// Starts voice's HTTP server for one test on a port the system picks, with
/// a `/health` route that reports ready.
///
/// - Parameters:
///   - maxConnections: The server's connection cap.
///   - headTimeout: Longest wait for a request head.
/// - Returns: The running server; the test stops it.
/// - Throws: The router's or the listener's error.
private func startWebServer(maxConnections: Int, headTimeout: Duration) async throws -> LoopbackServer {
    let router = try Router(routes: [.buildHealth(isReady: { true })])
    let server = WebServer(router: router, port: .any, maxConnections: maxConnections, headTimeout: headTimeout)
    let loopback = LoopbackServer()
    try await loopback.start { onReady in try await server.start(onReady: onReady) }
    return loopback
}

/// The request a health probe sends.
private let healthRequest = "GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"

/// Checks the HTTP server's limits over loopback.
@Suite("HTTP server limits", .timeLimit(.minutes(1)))
struct WebServerTests {
    /// Verifies a connection that sends no request head is answered with 408
    /// and closed once the head timeout passes.
    @Test func answersAnIdleConnectionWith408() async throws {
        let server = try await startWebServer(maxConnections: 4, headTimeout: .milliseconds(200))
        defer { server.stop() }

        let client = TestTCPClient(port: server.port)
        defer { client.cancel() }

        let response = try await client.readToEnd()
        #expect(String(decoding: response, as: UTF8.self).hasPrefix("HTTP/1.1 408 Request Timeout\r\n"))
    }

    /// Verifies a connection beyond the cap is closed without a response
    /// while the open one is still answered.
    @Test func dropsConnectionsBeyondTheCap() async throws {
        let server = try await startWebServer(maxConnections: 1, headTimeout: .seconds(30))
        defer { server.stop() }

        let first = TestTCPClient(port: server.port)
        defer { first.cancel() }
        try await waitUntil { first.states.isReady }
        let second = TestTCPClient(port: server.port)
        defer { second.cancel() }

        do {
            let dropped = try await second.readToEnd()
            #expect(dropped.isEmpty)
        } catch is TimedOutError {
            Issue.record("The connection beyond the cap was kept open")
        } catch {
            // A reset also shows the drop.
            #expect(error is NWError)
        }

        try await first.send(healthRequest)
        let response = try await first.readToEnd()
        #expect(String(decoding: response, as: UTF8.self).hasPrefix("HTTP/1.1 200 OK\r\n"))
    }

    /// Verifies stopping the server cancels a connection still waiting for
    /// its request head, and the server's start call returns.
    @Test func stoppingTheServerEndsAnOpenConnection() async throws {
        let server = try await startWebServer(maxConnections: 4, headTimeout: .seconds(30))
        defer { server.stop() }

        let client = TestTCPClient(port: server.port)
        defer { client.cancel() }
        try await waitUntil { client.states.isReady }

        try await server.stopAndWait()
        do {
            let received = try await client.readToEnd()
            #expect(received.isEmpty)
        } catch is TimedOutError {
            Issue.record("The open connection outlived the server")
        } catch {
            // A reset also shows the cancel.
            #expect(error is NWError)
        }
    }
}
