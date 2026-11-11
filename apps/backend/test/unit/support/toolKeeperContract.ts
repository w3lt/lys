import { toolDefinitionSchema, type ToolDefinition } from "@lys/share"
import { describe, expect, it, vi } from "vitest"
import type {
  ToolKeeper,
  ToolSearch
} from "../../../src/modules/agent/findToolsTool"

/** How every search of a keeper under test ends. */
export type ToolKeeperScript = "finds-first-tool" | "fails"

/**
 * Creates one keeper for the current test, whose every search ends as the
 * script says: finding the first of the search's tools, or failing after
 * reporting why; the keeper releases what it holds when the test ends.
 */
export type ToolKeeperFactory = (script: ToolKeeperScript) => ToolKeeper

/**
 * Builds the definition of a backend tool that takes no argument.
 *
 * @param name - Name of the tool.
 * @param description - What the tool does.
 * @returns The validated definition.
 */
function buildDefinition(name: string, description: string): ToolDefinition {
  return toolDefinitionSchema.parse({
    name,
    description,
    group: "network",
    access: "network",
    runner: "backend",
    arguments: []
  })
}

/** Tools of every search, in offer order. */
export const TOOL_KEEPER_SEARCH_TOOLS: readonly ToolDefinition[] =
  Object.freeze([
    buildDefinition("read_page", "Reads one web page and returns its text."),
    buildDefinition("send_email", "Sends an email message.")
  ])

/**
 * Builds a search for a web page reader.
 *
 * @param abortSignal - Cancellation of the asking reply.
 * @returns The search and the spy that receives its failures.
 */
function buildSearch(abortSignal: AbortSignal = new AbortController().signal) {
  const reportFailure = vi.fn<ToolSearch["reportFailure"]>()
  const search: ToolSearch = {
    task: "read a web page",
    tools: TOOL_KEEPER_SEARCH_TOOLS,
    conversationId: "0190a3f2-7b1c-7d3e-8f45-6a7b8c9d0e1f",
    model: "qwen/qwen3-8b",
    generationOptions: { temperature: 0.2 },
    abortSignal,
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
    it("finds names of the search's own tools only, frozen, reporting nothing", async () => {
      const { search, reportFailure } = buildSearch()

      const outcome = await createKeeper("finds-first-tool").findTools(search)

      expect(outcome).toEqual({ status: "found", toolNames: ["read_page"] })
      expect(
        outcome.status === "found" && Object.isFrozen(outcome.toolNames)
      ).toBe(true)
      expect(reportFailure).not.toHaveBeenCalled()
    })

    it("fails a search that ends without finding, after reporting why once", async () => {
      const { search, reportFailure } = buildSearch()

      const outcome = await createKeeper("fails").findTools(search)

      expect(outcome).toEqual({ status: "failed" })
      expect(reportFailure).toHaveBeenCalledOnce()
    })

    it("rejects with the abort reason of a search stopped before it starts, reporting nothing", async () => {
      const stopReason = new Error("stopped")
      const { search, reportFailure } = buildSearch(
        AbortSignal.abort(stopReason)
      )

      await expect(
        createKeeper("finds-first-tool").findTools(search)
      ).rejects.toBe(stopReason)
      expect(reportFailure).not.toHaveBeenCalled()
    })
  })
}
