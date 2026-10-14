import { describe, expect, it } from "vitest"
import { ScriptedBuiltInTool } from "../../../support/scriptedBuiltInTool"
import { registerBuiltInToolProviderContractSuite } from "../../../support/builtInToolProviderContract"
import { ScriptedBuiltInToolProvider } from "../../../support/scriptedBuiltInToolProvider"

registerBuiltInToolProviderContractSuite("for a scripted ready tool", () =>
  Promise.resolve({
    provider: new ScriptedBuiltInToolProvider({
      status: "ready",
      tool: new ScriptedBuiltInTool()
    }),
    expectedStatus: "ready"
  })
)

registerBuiltInToolProviderContractSuite(
  "for a scripted unavailable tool",
  () =>
    Promise.resolve({
      provider: new ScriptedBuiltInToolProvider({
        status: "unavailable",
        reason: "api-key-missing"
      }),
      expectedStatus: "unavailable"
    })
)

describe("ScriptedBuiltInToolProvider", () => {
  it("gives the scripted tool itself to every turn", async () => {
    const tool = new ScriptedBuiltInTool()
    const provider = new ScriptedBuiltInToolProvider({ status: "ready", tool })

    const firstLookup = await provider.findTurnTool()
    const secondLookup = await provider.findTurnTool()

    expect(firstLookup.status === "ready" && firstLookup.tool).toBe(tool)
    expect(secondLookup.status === "ready" && secondLookup.tool).toBe(tool)
  })

  it("gives the scripted reason to every turn", async () => {
    const provider = new ScriptedBuiltInToolProvider({
      status: "unavailable",
      reason: "api-key-invalid"
    })

    expect(await provider.findTurnTool()).toEqual({
      status: "unavailable",
      reason: "api-key-invalid"
    })
    expect(await provider.findTurnTool()).toEqual({
      status: "unavailable",
      reason: "api-key-invalid"
    })
  })
})
