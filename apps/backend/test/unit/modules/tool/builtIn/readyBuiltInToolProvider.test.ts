import { describe, expect, it } from "vitest"
import ReadyBuiltInToolProvider from "../../../../../src/modules/tool/builtIn/readyBuiltInToolProvider"
import { registerBuiltInToolProviderContractSuite } from "../../../support/builtInToolProviderContract"
import { ScriptedBuiltInTool } from "../../../support/scriptedBuiltInTool"

registerBuiltInToolProviderContractSuite(
  "for a tool that is always ready",
  () =>
    Promise.resolve({
      provider: new ReadyBuiltInToolProvider(new ScriptedBuiltInTool()),
      expectedStatus: "ready"
    })
)

describe("ReadyBuiltInToolProvider", () => {
  it("gives the same tool to every turn", async () => {
    const tool = new ScriptedBuiltInTool()
    const provider = new ReadyBuiltInToolProvider(tool)

    expect(await provider.prepareTool()).toEqual({ status: "ready", tool })
    expect(await provider.prepareTool()).toEqual({ status: "ready", tool })
  })
})
