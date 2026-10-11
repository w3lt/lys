import { describe, expect, it } from "vitest"
import type { BuiltInToolEntry } from "../../../../../src/modules/tool/builtIn/builtInTool"
import {
  createBuiltInTools,
  findBuiltInTools
} from "../../../../../src/modules/tool/builtIn/builtInTools"
import ReadPageTool, {
  buildReadPageDefinition
} from "../../../../../src/modules/tool/builtIn/web/readPageTool"
import {
  LOOK_UP_WORD_TOOL,
  ScriptedBuiltInTool
} from "../../../support/scriptedBuiltInTool"

/** Read-page entry followed by the scripted look-up entry. */
const ENTRIES: readonly BuiltInToolEntry[] = Object.freeze([
  ...createBuiltInTools(),
  Object.freeze({
    definition: LOOK_UP_WORD_TOOL,
    tool: new ScriptedBuiltInTool()
  })
])

describe("createBuiltInTools", () => {
  it("creates the read-page tool, frozen", () => {
    const entries = createBuiltInTools()

    expect(entries).toHaveLength(1)
    expect(entries[0]?.definition).toEqual(buildReadPageDefinition())
    expect(entries[0]?.tool).toBeInstanceOf(ReadPageTool)
    expect(Object.isFrozen(entries)).toBe(true)
  })

  it("refuses a URL of this machine through the production address rule", () => {
    const [readPage] = createBuiltInTools()

    const parsed = readPage?.tool.parseToolCall({ url: "http://[::1]/" })

    expect(parsed).toMatchObject({ status: "invalid" })
  })
})

describe("findBuiltInTools", () => {
  it("finds nothing when the request names no backend tool", () => {
    expect(findBuiltInTools(ENTRIES, undefined)).toEqual({
      status: "found",
      entries: []
    })
  })

  it("finds the named tools in the order the request named them", () => {
    const selection = findBuiltInTools(ENTRIES, ["look_up_word", "read_page"])

    expect(selection).toEqual({
      status: "found",
      entries: [ENTRIES[1], ENTRIES[0]]
    })
  })

  it("names every tool the backend does not have", () => {
    const selection = findBuiltInTools(ENTRIES, [
      "read_page",
      "web_search",
      "read_text_file"
    ])

    expect(selection).toEqual({
      status: "unknown",
      toolNames: ["web_search", "read_text_file"]
    })
  })
})
