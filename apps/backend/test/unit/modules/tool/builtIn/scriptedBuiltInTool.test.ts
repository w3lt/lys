import { registerBuiltInToolContractSuite } from "../../../support/builtInToolContract"
import { ScriptedBuiltInTool } from "../../../support/scriptedBuiltInTool"

registerBuiltInToolContractSuite(async () => {
  const tool = new ScriptedBuiltInTool()
  return {
    tool,
    runnableArguments: { word: "moth" },
    invalidArguments: { word: "unknown" },
    countStartedWork: () => tool.startedWords.length
  }
})
