import type { BuiltInToolEntry } from "./builtInTool"
import { lookupDnsHostAddresses } from "./web/pageRequest"
import ReadPageTool, {
  buildReadPageDefinition,
  PAGE_READ_TIMEOUT_MS
} from "./web/readPageTool"
import { isBlockedAddress } from "./web/webAddresses"

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

/**
 * Creates every tool the backend runs, in the order Settings lists them.
 *
 * @returns A frozen list holding the read-page tool, which resolves names
 * through the operating system and never connects to a blocked address.
 * Creating it contacts nothing.
 */
export function createBuiltInTools(): readonly BuiltInToolEntry[] {
  const readPageTool = new ReadPageTool({
    lookupHostAddresses: lookupDnsHostAddresses,
    isBlockedAddress,
    requestTimeoutMs: PAGE_READ_TIMEOUT_MS
  })
  const readPage: BuiltInToolEntry = Object.freeze({
    definition: buildReadPageDefinition(),
    tool: readPageTool
  })
  return Object.freeze([readPage])
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
