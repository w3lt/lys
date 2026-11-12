import type { ToolDefinition } from "@lys/share"
import { describe, expect, it, vi } from "vitest"
import type {
  ToolKeeper,
  ToolSearch
} from "../../../src/modules/agent/findToolsTool"
import { buildNetworkToolDefinition } from "./toolFixtures"

/** How every search of a keeper under test ends. */
export type ToolKeeperScript = "finds-task-tool" | "finds-nothing" | "fails"

/**
 * Creates one keeper for the current test, whose every search ends as the
 * script says: finding the tool its task names, finding none, or failing
 * after reporting why. The keeper runs two searches at once, and releases
 * what it holds when the test ends. Under `finds-task-tool` it calls
 * `handleToolFound`, when given, each time a search has found its tool and
 * has not settled yet.
 */
export type ToolKeeperFactory = (
  script: ToolKeeperScript,
  handleToolFound?: () => void
) => ToolKeeper

/** Tool that reads web pages. */
const READ_PAGE_TOOL = buildNetworkToolDefinition(
  "read_page",
  "Reads one web page and returns its text."
)

/** Tool that sends email. */
const SEND_EMAIL_TOOL = buildNetworkToolDefinition(
  "send_email",
  "Sends an email message."
)

/** Tools of a search in most cases, in offer order. */
export const TOOL_KEEPER_SEARCH_TOOLS: readonly ToolDefinition[] =
  Object.freeze([READ_PAGE_TOOL, SEND_EMAIL_TOOL])

/** What a case's search differs in from the search of most cases. */
type SearchOptions = Readonly<{
  /**
   * Task of the search, the name of the tool a keeper under
   * `finds-task-tool` finds; `read_page` by default.
   */
  task?: string
  /** Tools of the search; {@link TOOL_KEEPER_SEARCH_TOOLS} by default. */
  tools?: readonly ToolDefinition[]
  /** Cancellation of the asking reply; never aborted by default. */
  abortSignal?: AbortSignal
}>

/**
 * Builds a search.
 *
 * @param options - What the search differs in from the default one.
 * @returns The search and the spy that receives its failures.
 */
function buildSearch(options: SearchOptions = {}) {
  const reportFailure = vi.fn<ToolSearch["reportFailure"]>()
  const search: ToolSearch = {
    task: options.task ?? "read_page",
    tools: options.tools ?? TOOL_KEEPER_SEARCH_TOOLS,
    conversationId: "0190a3f2-7b1c-7d3e-8f45-6a7b8c9d0e1f",
    model: "qwen/qwen3-8b",
    generationOptions: { temperature: 0.2 },
    abortSignal: options.abortSignal ?? new AbortController().signal,
    reportFailure
  }
  return { search, reportFailure }
}

/**
 * Registers the cases every {@link ToolKeeper} passes.
 *
 * @param createKeeper - Creates a fresh keeper for each case.
 */
export function registerToolKeeperContractSuite(
  createKeeper: ToolKeeperFactory
): void {
  describe("ToolKeeper contract", () => {
    it("finds a tool of its search, in a frozen outcome, reporting nothing", async () => {
      const { search, reportFailure } = buildSearch()

      const outcome = await createKeeper("finds-task-tool").findTools(search)

      expect(outcome).toEqual({ status: "found", toolNames: ["read_page"] })
      expect(Object.isFrozen(outcome)).toBe(true)
      expect(
        outcome.status === "found" && Object.isFrozen(outcome.toolNames)
      ).toBe(true)
      expect(reportFailure).not.toHaveBeenCalled()
    })

    it("answers found with no tool when it finds none, in a frozen outcome, reporting nothing", async () => {
      const { search, reportFailure } = buildSearch()

      const outcome = await createKeeper("finds-nothing").findTools(search)

      expect(outcome).toEqual({ status: "found", toolNames: [] })
      expect(Object.isFrozen(outcome)).toBe(true)
      expect(
        outcome.status === "found" && Object.isFrozen(outcome.toolNames)
      ).toBe(true)
      expect(reportFailure).not.toHaveBeenCalled()
    })

    it("runs two searches that overlap, each over its own tools to its own outcome, reporting nothing", async () => {
      const keeper = createKeeper("finds-task-tool")
      const first = buildSearch({ task: "read_page", tools: [READ_PAGE_TOOL] })
      const second = buildSearch({
        task: "send_email",
        tools: [SEND_EMAIL_TOOL]
      })

      const outcomes = await Promise.all([
        keeper.findTools(first.search),
        keeper.findTools(second.search)
      ])

      expect(outcomes).toEqual([
        { status: "found", toolNames: ["read_page"] },
        { status: "found", toolNames: ["send_email"] }
      ])
      expect(first.reportFailure).not.toHaveBeenCalled()
      expect(second.reportFailure).not.toHaveBeenCalled()
    })

    it("fails a search that ends without finding, after reporting why once", async () => {
      const { search, reportFailure } = buildSearch()

      const outcome = await createKeeper("fails").findTools(search)

      expect(outcome).toEqual({ status: "failed" })
      expect(reportFailure).toHaveBeenCalledOnce()
    })

    it("rejects with the abort reason of a search stopped before it starts, reporting nothing", async () => {
      const stopReason = new Error("stopped")
      const { search, reportFailure } = buildSearch({
        abortSignal: AbortSignal.abort(stopReason)
      })

      await expect(
        createKeeper("finds-task-tool").findTools(search)
      ).rejects.toBe(stopReason)
      expect(reportFailure).not.toHaveBeenCalled()
    })

    it("rejects with the abort reason of a search stopped just after it starts, reporting nothing", async () => {
      const stopReason = new Error("stopped")
      const stop = new AbortController()
      const { search, reportFailure } = buildSearch({
        abortSignal: stop.signal
      })

      const outcome = createKeeper("finds-task-tool").findTools(search)
      stop.abort(stopReason)

      await expect(outcome).rejects.toBe(stopReason)
      expect(reportFailure).not.toHaveBeenCalled()
    })

    it("rejects with the abort reason of a search stopped after it found its tool, reporting nothing", async () => {
      const stopReason = new Error("stopped")
      const stop = new AbortController()
      const { search, reportFailure } = buildSearch({
        abortSignal: stop.signal
      })
      const handleToolFound = vi.fn(() => {
        stop.abort(stopReason)
      })
      const keeper = createKeeper("finds-task-tool", handleToolFound)

      await expect(keeper.findTools(search)).rejects.toBe(stopReason)
      expect(handleToolFound).toHaveBeenCalledOnce()
      expect(reportFailure).not.toHaveBeenCalled()
    })
  })
}
