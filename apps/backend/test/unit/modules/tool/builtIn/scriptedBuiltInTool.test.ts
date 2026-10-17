import { describe, expect, it } from "vitest"
import type { BuiltInToolRunContext } from "../../../../../src/modules/tool/builtIn/builtInTool"
import {
  createRecordedRunContext,
  registerBuiltInToolContractSuite
} from "../../../support/builtInToolContract"
import {
  answerWithWordSource,
  ScriptedBuiltInTool
} from "../../../support/scriptedBuiltInTool"

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

  it("hands each run's word and context to its script and records the words in start order", async () => {
    const scriptRuns: Readonly<{
      word: string
      context: BuiltInToolRunContext
    }>[] = []
    const tool = new ScriptedBuiltInTool((word, context) => {
      scriptRuns.push({ word, context })
      return Promise.resolve({
        status: "succeeded",
        content: `${word}: run`,
        sources: []
      })
    })
    const mothContext = createRecordedRunContext(
      new AbortController().signal
    ).context
    const lampContext = createRecordedRunContext(
      new AbortController().signal
    ).context
    const mothCall = tool.parseToolCall({ word: "moth" })
    const lampCall = tool.parseToolCall({ word: "lamp" })
    if (mothCall.status !== "parsed" || lampCall.status !== "parsed") {
      throw new Error("Expected parsed calls")
    }

    const results = await Promise.all([
      mothCall.runToolCall(mothContext),
      lampCall.runToolCall(lampContext)
    ])

    expect(results).toEqual([
      { status: "succeeded", content: "moth: run", sources: [] },
      { status: "succeeded", content: "lamp: run", sources: [] }
    ])
    expect(scriptRuns.map((run) => run.word)).toEqual(["moth", "lamp"])
    expect(scriptRuns[0]?.context).toBe(mothContext)
    expect(scriptRuns[1]?.context).toBe(lampContext)
    expect(tool.startedWords).toEqual(["moth", "lamp"])
  })

  it("numbers the word's dictionary page through the run's numbering when its script cites it", async () => {
    const tool = new ScriptedBuiltInTool(answerWithWordSource)
    const call = tool.parseToolCall({ word: "moth" })
    if (call.status !== "parsed") throw new Error("Expected a parsed call")
    const recorded = createRecordedRunContext(new AbortController().signal)

    const result = await call.runToolCall(recorded.context)

    const source = {
      number: 1,
      url: "https://words.example/moth",
      title: "Dictionary: moth"
    }
    expect(result).toEqual({
      status: "succeeded",
      content: "moth: a definition. Source [1]",
      sources: [source]
    })
    expect(recorded.numberedSources).toEqual([source])
  })
})
