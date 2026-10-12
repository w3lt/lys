import {
  TAVILY_API_HOST,
  type BackendToolUnavailableReason
} from "@lys/protocol"
import type {
  BuiltInToolEntry,
  BuiltInToolProvider,
  TurnBuiltInTool
} from "./builtInTool"
import ReadyBuiltInToolProvider from "./readyBuiltInToolProvider"
import ReadPageTool, {
  buildReadPageDefinition,
  PAGE_READ_TIMEOUT_MS
} from "./web/readPageTool"
import type { TavilyRequestDependencies } from "./web/tavilyRequest"
import { isBlockedAddress } from "./web/webAddresses"
import { lookupDnsHostAddresses } from "./web/webConnection"
import {
  buildWebSearchDefinition,
  WEB_SEARCH_TIMEOUT_MS
} from "./web/webSearchTool"

/** Outcome of finding the built-in tools a request names. */
export type BuiltInToolSelection =
  | Readonly<{
      /** Every name belongs to a built-in tool. */
      status: "found"
      /** The named tools, in the order the request named them. */
      entries: readonly BuiltInToolEntry[]
    }>
  | Readonly<{
      /** Some names belong to no built-in tool. */
      status: "unknown"
      /** The unknown names, in the order the request named them. */
      toolNames: readonly string[]
    }>

/** Selection of a request that names no built-in tool. */
const NO_BUILT_IN_TOOLS: BuiltInToolSelection = Object.freeze({
  status: "found",
  entries: Object.freeze([])
})

/** Outcome of preparing every backend tool a request offers. */
export type BuiltInToolSetPreparation =
  | Readonly<{
      /** Every offered tool can run. */
      status: "ready"
      /** The prepared tools, in offer order. */
      tools: readonly TurnBuiltInTool[]
    }>
  | Readonly<{
      /** An offered tool cannot run. */
      status: "unavailable"
      /** Name of the first offered tool that cannot run, in offer order. */
      toolName: string
      /** Why it cannot run. */
      reason: BackendToolUnavailableReason
    }>

/**
 * Builds the settings of every production request to Tavily.
 *
 * @returns Frozen settings: `https://` plus the shared Tavily host, the
 * operating system's resolver, the address rule that never connects to this
 * machine or a private network, and the 15-second time limit.
 */
export function buildTavilyRequestDependencies(): TavilyRequestDependencies {
  return Object.freeze({
    origin: `https://${TAVILY_API_HOST}`,
    lookupHostAddresses: lookupDnsHostAddresses,
    isBlockedAddress,
    requestTimeoutMs: WEB_SEARCH_TIMEOUT_MS
  })
}

/**
 * Creates every tool the backend runs, in the order Settings lists them.
 *
 * @param webSearchToolProvider - Provider of the web search tool, lent for
 * the backend's lifetime.
 * @returns A frozen list: the read-page tool, always ready, which resolves
 * names through the operating system and never connects to a blocked
 * address; then the web search tool. Creating it reads and contacts nothing.
 */
export function createBuiltInTools(
  webSearchToolProvider: BuiltInToolProvider
): readonly BuiltInToolEntry[] {
  const readPageTool = new ReadPageTool({
    lookupHostAddresses: lookupDnsHostAddresses,
    isBlockedAddress,
    requestTimeoutMs: PAGE_READ_TIMEOUT_MS
  })
  const readPage: BuiltInToolEntry = Object.freeze({
    definition: buildReadPageDefinition(),
    provider: new ReadyBuiltInToolProvider(readPageTool)
  })
  const webSearch: BuiltInToolEntry = Object.freeze({
    definition: buildWebSearchDefinition(),
    provider: webSearchToolProvider
  })
  return Object.freeze([readPage, webSearch])
}

/**
 * Finds the built-in tools a request names.
 *
 * @param entries - Every built-in tool.
 * @param toolNames - Names a request offers, each once; undefined when it
 * names none.
 * @returns `found` with the named tools, or `unknown` with every name that
 * belongs to no built-in tool.
 */
export function findBuiltInTools(
  entries: readonly BuiltInToolEntry[],
  toolNames: readonly string[] | undefined
): BuiltInToolSelection {
  if (toolNames === undefined) return NO_BUILT_IN_TOOLS
  const entriesByName = new Map(
    entries.map((entry) => [entry.definition.name, entry])
  )
  const unknownNames = toolNames.filter((name) => !entriesByName.has(name))
  if (unknownNames.length > 0) {
    return Object.freeze({
      status: "unknown",
      toolNames: Object.freeze(unknownNames)
    })
  }
  const found = toolNames.flatMap((name) => entriesByName.get(name) ?? [])
  return Object.freeze({ status: "found", entries: Object.freeze(found) })
}

/**
 * Prepares every backend tool a request offers for one turn.
 *
 * @param entries - Offered tools, in offer order.
 * @returns `ready` with every prepared tool in offer order, or `unavailable`
 * naming the first offered tool that cannot run and why. Every provider is
 * asked at once.
 * @throws A provider's defect.
 */
export async function prepareBuiltInTools(
  entries: readonly BuiltInToolEntry[]
): Promise<BuiltInToolSetPreparation> {
  const preparations = await Promise.all(
    entries.map((entry) => entry.provider.prepareTool())
  )
  const tools: TurnBuiltInTool[] = []
  for (const [index, entry] of entries.entries()) {
    const preparation = preparations[index]
    if (preparation === undefined) {
      throw new Error("A tool preparation is missing")
    }
    if (preparation.status === "unavailable") {
      return Object.freeze({
        status: "unavailable",
        toolName: entry.definition.name,
        reason: preparation.reason
      })
    }
    tools.push(
      Object.freeze({ definition: entry.definition, tool: preparation.tool })
    )
  }
  return Object.freeze({ status: "ready", tools: Object.freeze(tools) })
}
