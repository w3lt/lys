import { describe, expect, it } from "vitest"
import type {
  BuiltInTool,
  BuiltInToolCallArguments
} from "../../../src/modules/tool/builtIn/builtInTool"

/** One ready built-in tool with arguments it can and cannot run. */
export type BuiltInToolHarness = Readonly<{
  /** Tool under test. */
  tool: BuiltInTool
  /** Arguments of a call whose run succeeds. */
  runnableArguments: BuiltInToolCallArguments
  /** Arguments of a call the tool can never run. */
  invalidArguments: BuiltInToolCallArguments
  /** Number of runs that started work, such as requests a server received. */
  countStartedWork: () => number
}>

/**
 * Creates one ready tool for the current test, which releases everything it
 * acquired when the test finishes.
 */
export type BuiltInToolHarnessFactory = () => Promise<BuiltInToolHarness>

/**
 * Registers the cases every {@link BuiltInTool} implementation passes.
 *
 * @param createHarness - Creates a fresh tool for each case.
 */
export function registerBuiltInToolContractSuite(
  createHarness: BuiltInToolHarnessFactory
): void {
  describe("BuiltInTool contract", () => {
    it("explains arguments it can never run without starting any work", async () => {
      const harness = await createHarness()

      const parsed = harness.tool.parseToolCall(harness.invalidArguments)

      expect(parsed.status).toBe("invalid")
      expect(parsed.status === "invalid" && parsed.message).not.toBe("")
      expect(harness.countStartedWork()).toBe(0)
    })

    it("parses runnable arguments without starting any work", async () => {
      const harness = await createHarness()

      const parsed = harness.tool.parseToolCall(harness.runnableArguments)

      expect(parsed.status).toBe("parsed")
      expect(harness.countStartedWork()).toBe(0)
    })

    it("runs a parsed call and gives the model text", async () => {
      const harness = await createHarness()
      const parsed = harness.tool.parseToolCall(harness.runnableArguments)
      if (parsed.status !== "parsed") throw new Error("Expected a parsed call")

      const result = await parsed.runToolCall(new AbortController().signal)

      expect(result.status).toBe("succeeded")
      expect(result.content).not.toBe("")
      expect(harness.countStartedWork()).toBe(1)
    })

    it("runs each invocation of a parsed call independently", async () => {
      const harness = await createHarness()
      const parsed = harness.tool.parseToolCall(harness.runnableArguments)
      if (parsed.status !== "parsed") throw new Error("Expected a parsed call")

      const results = await Promise.all([
        parsed.runToolCall(new AbortController().signal),
        parsed.runToolCall(new AbortController().signal)
      ])

      expect(results.map((result) => result.status)).toEqual([
        "succeeded",
        "succeeded"
      ])
      expect(harness.countStartedWork()).toBe(2)
    })

    it("rejects with the abort reason and starts no work when already stopped", async () => {
      const harness = await createHarness()
      const parsed = harness.tool.parseToolCall(harness.runnableArguments)
      if (parsed.status !== "parsed") throw new Error("Expected a parsed call")
      const abortController = new AbortController()
      const stopReason = new Error("stopped")
      abortController.abort(stopReason)

      await expect(parsed.runToolCall(abortController.signal)).rejects.toBe(
        stopReason
      )
      expect(harness.countStartedWork()).toBe(0)
    })
  })
}
