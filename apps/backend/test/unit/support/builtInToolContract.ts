import type { ConversationSource } from "@lys/share"
import { describe, expect, it } from "vitest"
import SourceCatalog from "../../../src/modules/agent/sourceCatalog"
import type {
  BuiltInTool,
  BuiltInToolCallArguments,
  BuiltInToolRunContext
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

/** Run context of one test run and every source its numbering returned. */
type RecordedRunContext = Readonly<{
  /** Context to run the call with. */
  context: BuiltInToolRunContext
  /** Sources the numbering returned, in the order it returned them. */
  numberedSources: readonly ConversationSource[]
}>

/**
 * Creates a run context that numbers sources as a turn of a conversation
 * without stored sources does, and records what it returned.
 *
 * @param abortSignal - Signal the run observes.
 * @returns The context and the live record of numbered sources.
 * @remarks Numbering starts at 1, gives each new URL the next number, and
 * keeps a known URL's number, through the production {@link SourceCatalog}.
 */
export function createRecordedRunContext(
  abortSignal: AbortSignal
): RecordedRunContext {
  const numberedSources: ConversationSource[] = []
  const sourceCatalog = new SourceCatalog([])
  return {
    context: {
      abortSignal,
      addWebSources: (candidates) => {
        const sources = sourceCatalog.addWebSources(candidates)
        numberedSources.push(...sources)
        return sources
      }
    },
    numberedSources
  }
}

/**
 * Registers the {@link BuiltInTool} case about the sources a run shows.
 *
 * @param createHarness - Creates a fresh tool for each case.
 */
function registerBuiltInToolSourceCase(
  createHarness: BuiltInToolHarnessFactory
): void {
  it("shows only sources the turn numbered for it", async () => {
    const harness = await createHarness()
    const parsed = harness.tool.parseToolCall(harness.runnableArguments)
    if (parsed.status !== "parsed") throw new Error("Expected a parsed call")
    const recorded = createRecordedRunContext(new AbortController().signal)

    const result = await parsed.runToolCall(recorded.context)

    if (result.status !== "succeeded") throw new Error("Expected a success")
    for (const source of result.sources)
      expect(recorded.numberedSources).toContainEqual(source)
  })
}

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

      const recorded = createRecordedRunContext(new AbortController().signal)

      const result = await parsed.runToolCall(recorded.context)

      expect(result.status).toBe("succeeded")
      expect(result.content).not.toBe("")
      expect(harness.countStartedWork()).toBe(1)
    })

    registerBuiltInToolSourceCase(createHarness)

    it("runs each invocation of a parsed call independently", async () => {
      const harness = await createHarness()
      const parsed = harness.tool.parseToolCall(harness.runnableArguments)
      if (parsed.status !== "parsed") throw new Error("Expected a parsed call")

      const results = await Promise.all([
        parsed.runToolCall(
          createRecordedRunContext(new AbortController().signal).context
        ),
        parsed.runToolCall(
          createRecordedRunContext(new AbortController().signal).context
        )
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

      await expect(
        parsed.runToolCall(
          createRecordedRunContext(abortController.signal).context
        )
      ).rejects.toBe(stopReason)
      expect(harness.countStartedWork()).toBe(0)
    })
  })
}
