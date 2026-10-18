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

  it("is not ready when vmo does not answer within the time limit", async () => {
    const server = await startVmoServer(() => {
      // Never answers, so only the time limit ends the check.
    })

    const startedAt = performance.now()
    const health = await sendVmoHealthCheck(server.origin, 100)

    expect(health).toBe("not-ready")
    expect(performance.now() - startedAt).toBeLessThan(1_000)
  })

  it("gives every check one second", () => {
    expect(VMO_HEALTH_TIMEOUT_MS).toBe(1_000)
  })
})
