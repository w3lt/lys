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
