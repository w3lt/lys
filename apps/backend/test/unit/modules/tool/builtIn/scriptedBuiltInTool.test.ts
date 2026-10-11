import { describe, expect, it } from "vitest"
import { registerBuiltInToolContractSuite } from "../../../support/builtInToolContract"
import { ScriptedBuiltInTool } from "../../../support/scriptedBuiltInTool"

describe("ScriptedBuiltInTool", () => {
  registerBuiltInToolContractSuite(async () => {
    const tool = new ScriptedBuiltInTool()
    return {
      tool,
      runnableArguments: { word: "moth" },
      invalidArguments: { word: "unknown" },
      countStartedWork: () => tool.startedWords.length
    }
  })

  it("hands each run's word and signal to its script and records the words in start order", async () => {
    const scriptRuns: Readonly<{ word: string; abortSignal: AbortSignal }>[] =
      []
    const tool = new ScriptedBuiltInTool((word, abortSignal) => {
      scriptRuns.push({ word, abortSignal })
      return Promise.resolve({ status: "succeeded", content: `${word}: run` })
    })
    const mothSignal = new AbortController().signal
    const lampSignal = new AbortController().signal
    const mothCall = tool.parseToolCall({ word: "moth" })
    const lampCall = tool.parseToolCall({ word: "lamp" })
    if (mothCall.status !== "parsed" || lampCall.status !== "parsed") {
      throw new Error("Expected parsed calls")
    }

    const results = await Promise.all([
      mothCall.runToolCall(mothSignal),
      lampCall.runToolCall(lampSignal)
    ])

    expect(results).toEqual([
      { status: "succeeded", content: "moth: run" },
      { status: "succeeded", content: "lamp: run" }
    ])
    expect(scriptRuns.map((run) => run.word)).toEqual(["moth", "lamp"])
    expect(scriptRuns[0]?.abortSignal).toBe(mothSignal)
    expect(scriptRuns[1]?.abortSignal).toBe(lampSignal)
    expect(tool.startedWords).toEqual(["moth", "lamp"])
  })
})
