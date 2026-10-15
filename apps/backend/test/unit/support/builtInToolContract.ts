import type { ConversationSource } from "@lys/share"
import { describe, expect, it } from "vitest"
import type {
  BuiltInTool,
  BuiltInToolCallArguments,
  BuiltInToolRunContext,
  WebSourceCandidate
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
 * Creates a run context that numbers sources from 1, a new number per call
 * of the numbering, and records what it returned.
 *
 * @param abortSignal - Signal the run observes.
 * @returns The context and the live record of numbered sources.
 */
export function createRecordedRunContext(
  abortSignal: AbortSignal
): RecordedRunContext {
  const numberedSources: ConversationSource[] = []
  return {
    context: {
      abortSignal,
      addWebSources: (candidates) =>
        addRecordedSources(numberedSources, candidates)
    },
    numberedSources
  }
}

/**
 * Numbers candidates after every source numbered before and records them.
 *
 * @param numberedSources - Sources numbered so far; extended in place.
 * @param candidates - Sources a run is about to show.
 * @returns The candidates numbered in order.
 */
function addRecordedSources(
  numberedSources: ConversationSource[],
  candidates: readonly WebSourceCandidate[]
): readonly ConversationSource[] {
  const sources = candidates.map((candidate, index) => ({
    number: numberedSources.length + index + 1,
    url: candidate.url,
    title: candidate.title
  }))
  numberedSources.push(...sources)
  return sources
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
