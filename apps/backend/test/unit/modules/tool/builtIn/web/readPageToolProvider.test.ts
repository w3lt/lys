import { describe, expect, it } from "vitest"
import ReadPageToolProvider from "../../../../../../src/modules/tool/builtIn/web/readPageToolProvider"
import { registerBuiltInToolProviderContractSuite } from "../../../../support/builtInToolProviderContract"
import { ScriptedBuiltInTool } from "../../../../support/scriptedBuiltInTool"
import {
  answerWithBody,
  findClosedVmoOrigin,
  startVmoServer,
  type VmoRoute
} from "../../../../support/vmoServer"

/** Route of a vmo that can read pages. */
const ANSWER_READY: VmoRoute = answerWithBody(
  200,
  "text/plain; charset=utf-8",
  "ok\n"
)

registerBuiltInToolProviderContractSuite(
  "while vmo answers its health route",
  async () => {
    const server = await startVmoServer(ANSWER_READY)
    return {
      provider: new ReadPageToolProvider(
        new ScriptedBuiltInTool(),
        server.origin,
        1_000
      ),
      expectedStatus: "ready"
    }
  }
)

registerBuiltInToolProviderContractSuite(
  "while nothing listens on vmo's port",
  async () => ({
    provider: new ReadPageToolProvider(
      new ScriptedBuiltInTool(),
      await findClosedVmoOrigin(),
      1_000
    ),
    expectedStatus: "unavailable"
  })
)

describe("ReadPageToolProvider", () => {
  it("gives the tool to a turn while vmo answers, asking vmo on every lookup", async () => {
    const tool = new ScriptedBuiltInTool()
    const server = await startVmoServer(ANSWER_READY)
    const provider = new ReadPageToolProvider(tool, server.origin, 1_000)

    expect(await provider.findTurnTool()).toEqual({ status: "ready", tool })
    expect(await provider.findTurnTool()).toEqual({ status: "ready", tool })
    expect(server.receivedRequests.map((request) => request.path)).toEqual([
      "/health",
      "/health"
    ])
  })

  it("says the page reader is not ready when vmo answers with another status", async () => {
    const server = await startVmoServer(
      answerWithBody(503, "text/plain; charset=utf-8", "starting\n")
    )
    const provider = new ReadPageToolProvider(
      new ScriptedBuiltInTool(),
      server.origin,
      1_000
    )

    expect(await provider.findTurnTool()).toEqual({
      status: "unavailable",
      reason: "page-reader-not-ready"
    })
  })

  it("says the page reader is not ready when vmo does not answer in time", async () => {
    const server = await startVmoServer(() => {
      // Never answers, so only the time limit ends the check.
    })
    const provider = new ReadPageToolProvider(
      new ScriptedBuiltInTool(),
      server.origin,
      100
    )

    expect(await provider.findTurnTool()).toEqual({
      status: "unavailable",
      reason: "page-reader-not-ready"
    })
  })
})
