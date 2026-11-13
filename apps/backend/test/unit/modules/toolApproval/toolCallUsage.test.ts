import { describe, expect, it } from "vitest"
import ToolCallUsage from "../../../../src/modules/toolApproval/toolCallUsage"

describe("ToolCallUsage", () => {
  it("counts no call of a tool never added", () => {
    expect(new ToolCallUsage().countToolCalls("web_search")).toBe(0)
  })

  it("counts each tool's added calls on their own", () => {
    const usage = new ToolCallUsage()

    usage.addToolCall("web_search")
    usage.addToolCall("read_page")
    usage.addToolCall("web_search")

    expect(usage.countToolCalls("web_search")).toBe(2)
    expect(usage.countToolCalls("read_page")).toBe(1)
  })
})
