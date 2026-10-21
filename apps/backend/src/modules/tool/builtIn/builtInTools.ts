import {
  TAVILY_API_HOST,
  type BackendToolUnavailableReason
} from "@lys/protocol"
import type {
  BuiltInToolEntry,
  BuiltInToolProvider,
  TurnBuiltInTool
} from "./builtInTool"
import ReadPageTool, {
  buildReadPageDefinition,
  PAGE_READER_TIMEOUT_MS
} from "./web/readPageTool"
import ReadPageToolProvider from "./web/readPageToolProvider"
import type { TavilyRequestDependencies } from "./web/tavilyRequest"
import { VMO_HEALTH_TIMEOUT_MS } from "./web/vmoHealth"
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

/** Outcome of looking up every backend tool a request offers. */
export type TurnToolSetLookup =
  | Readonly<{
      /** Every offered tool can run. */
      status: "ready"
      /** The tools found, in offer order. */
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
 * @param vmoOrigin - Origin of vmo, the page reader the read-page tool asks,
 * such as `http://127.0.0.1:8080`.
 * @param reportPageReaderFailure - Receives why vmo could not be reached,
 * gave an answer Lys does not understand, or did not answer in time, for
 * logging.
 * @returns A frozen list: the read-page tool, ready only while vmo answers
 * its health route within one second, which resolves a page's host name
 * through the operating system, refuses it when it resolves to a blocked
 * address, and otherwise asks vmo to read the page, within 60 seconds; then
 * the web search tool. Creating it reads, starts, and contacts nothing.
 */
export function createBuiltInTools(
  webSearchToolProvider: BuiltInToolProvider,
  vmoOrigin: string,
  reportPageReaderFailure: (failure: unknown) => void
): readonly BuiltInToolEntry[] {
  const readPageTool = new ReadPageTool({
    lookupHostAddresses: lookupDnsHostAddresses,
    isBlockedAddress,
    reportPageReaderFailure,
    vmoOrigin,
    readTimeoutMs: PAGE_READER_TIMEOUT_MS
  })
  const readPage: BuiltInToolEntry = Object.freeze({
    definition: buildReadPageDefinition(),
    provider: new ReadPageToolProvider(
      readPageTool,
      vmoOrigin,
      VMO_HEALTH_TIMEOUT_MS
    )
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
 * Finds the tools that run one turn's calls, one for each offered backend tool.
 *
 * @param entries - Offered tools, in offer order.
 * @returns `ready` with every tool found, in offer order, or `unavailable`
 * naming the first offered tool that cannot run and why. Every provider is
 * asked at once.
 * @throws A provider's defect.
 */
export async function findTurnBuiltInTools(
  entries: readonly BuiltInToolEntry[]
): Promise<TurnToolSetLookup> {
  const lookups = await Promise.all(
    entries.map((entry) => entry.provider.findTurnTool())
  )
  const tools: TurnBuiltInTool[] = []
  for (const [index, entry] of entries.entries()) {
    const lookup = lookups[index]
    if (lookup === undefined) {
      throw new Error("A tool lookup is missing")
    }
    if (lookup.status === "unavailable") {
      return Object.freeze({
        status: "unavailable",
        toolName: entry.definition.name,
        reason: lookup.reason
      })
    }
    tools.push(
      Object.freeze({
        definition: entry.definition,
        tool: lookup.tool,
        runsWithoutApproval: false
      })
    )
  }
  return Object.freeze({ status: "ready", tools: Object.freeze(tools) })
}
