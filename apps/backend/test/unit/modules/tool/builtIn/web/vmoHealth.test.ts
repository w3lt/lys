import { describe, expect, it } from "vitest"
import {
  sendVmoHealthCheck,
  VMO_HEALTH_TIMEOUT_MS
} from "../../../../../../src/modules/tool/builtIn/web/vmoHealth"
import {
  answerWithBody,
  findClosedVmoOrigin,
  startVmoServer
} from "../../../../support/vmoServer"

describe("sendVmoHealthCheck", () => {
  it("is ready when vmo answers GET /health with 200", async () => {
    const server = await startVmoServer(
      answerWithBody(200, "text/plain; charset=utf-8", "ok\n")
    )

    const health = await sendVmoHealthCheck(server.origin, 1_000)

    expect(health).toBe("ready")
    expect(server.receivedRequests).toMatchObject([
      { method: "GET", path: "/health" }
    ])
  })

  it("is not ready when vmo answers with another status", async () => {
    const server = await startVmoServer(
      answerWithBody(503, "text/plain; charset=utf-8", "starting\n")
    )

    expect(await sendVmoHealthCheck(server.origin, 1_000)).toBe("not-ready")
  })

  it("is not ready when nothing listens on vmo's port", async () => {
    expect(await sendVmoHealthCheck(await findClosedVmoOrigin(), 1_000)).toBe(
      "not-ready"
    )
  })

  it("is not ready when vmo closes the connection without answering", async () => {
    const server = await startVmoServer((request) => request.socket.destroy())

    expect(await sendVmoHealthCheck(server.origin, 1_000)).toBe("not-ready")
  })

  it("is not ready when what listens on vmo's port answers with something other than HTTP", async () => {
    const server = await startVmoServer((request) =>
      request.socket.end("NOT HTTP\r\n\r\n")
    )

    expect(await sendVmoHealthCheck(server.origin, 1_000)).toBe("not-ready")
  })

  it("is not ready when vmo does not answer within the time limit", async () => {
    const server = await startVmoServer(() => {
      // Never answers, so only the time limit ends the check.
    })

    const startedAt = performance.now()
    const health = await sendVmoHealthCheck(server.origin, 100)

    expect(health).toBe("not-ready")
    expect(performance.now() - startedAt).toBeLessThan(1_000)
  })

  it("closes its connection once a 200 arrives, though the body never ends", async () => {
    const connectionClosed = Promise.withResolvers<void>()
    const server = await startVmoServer((request, response) => {
      request.socket.once("close", () => connectionClosed.resolve())
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
      response.write("ok")
    })

    // The limit outlasts the case, so only the check itself can close it.
    expect(await sendVmoHealthCheck(server.origin, 60_000)).toBe("ready")
    await connectionClosed.promise
  })

  it("closes its connection when vmo does not answer within the time limit", async () => {
    const connectionClosed = Promise.withResolvers<void>()
    const server = await startVmoServer((request) =>
      request.socket.once("close", () => connectionClosed.resolve())
    )

    expect(await sendVmoHealthCheck(server.origin, 100)).toBe("not-ready")
    await connectionClosed.promise
  })

  it.each([
    ["is not a URL", "not a url", "ERR_INVALID_URL"],
    ["is not an http URL", "ftp://127.0.0.1:8080", "ERR_INVALID_PROTOCOL"]
  ])(
    "rejects, as a defect, an origin that %s",
    async (_label, vmoOrigin, code) => {
      await expect(sendVmoHealthCheck(vmoOrigin, 1_000)).rejects.toMatchObject({
        code
      })
    }
  )

  it("gives every check one second", () => {
    expect(VMO_HEALTH_TIMEOUT_MS).toBe(1_000)
  })
})
