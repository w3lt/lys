import type {
  BackendToolUnavailableReason,
  UnavailableBackendTool
} from "@lys/protocol"

/**
 * What a turn tells the model about the tools it does not offer, as the
 * client's request names them.
 *
 * @remarks `status` selects the variant. With tool calls off, the client
 * offers no tool, so nothing is named; with tool calls on, it names the
 * tools the person switched off and the switched-on backend tools that
 * cannot run now. A turn never offers a named tool.
 */
export type UnofferedTools =
  | Readonly<{
      /** The person switched tool calls off in Settings → Tools. */
      status: "tool-calls-off"
    }>
  | Readonly<{
      /** Tool calls are on. */
      status: "tool-calls-on"
      /** Tools the person switched off, each once; empty when none is. */
      switchedOffToolNames: readonly string[]
      /**
       * Switched-on backend tools that cannot run now, each once with why;
       * empty when none.
       */
      unavailableTools: readonly UnavailableBackendTool[]
    }>

/** Switched-off names of a turn that names none. */
const NO_SWITCHED_OFF_TOOL_NAMES: readonly string[] = Object.freeze([])

/** Unavailable tools of a turn that names none. */
const NO_UNAVAILABLE_TOOLS: readonly UnavailableBackendTool[] = Object.freeze(
  []
)

/**
 * Unoffered tools of a turn with tool calls on that names no tool; its lists
 * are the empty lists of a request that leaves one out.
 */
export const NO_UNOFFERED_TOOLS = Object.freeze({
  status: "tool-calls-on",
  switchedOffToolNames: NO_SWITCHED_OFF_TOOL_NAMES,
  unavailableTools: NO_UNAVAILABLE_TOOLS
} as const satisfies UnofferedTools)

/** Unoffered tools of a turn whose person switched tool calls off. */
export const TOOL_CALLS_OFF: UnofferedTools = Object.freeze({
  status: "tool-calls-off"
})

/**
 * Why a switched-on tool cannot run now and what fixes it, by reason, as the
 * model reads it; a new reason must add one.
 */
const UNAVAILABLE_TOOL_CLAUSES = Object.freeze({
  "api-key-missing":
    "no Tavily API key is saved (one can be added in Settings → Secrets)",
  "api-key-invalid":
    "the Tavily API key in settings.json is not valid (it can be fixed or removed there as secrets.tavilyApiKey)",
  "settings-unreadable":
    "Lys cannot read its settings file, settings.json (it can be fixed by hand)",
  "page-reader-not-ready":
    "vmo, Lys's page reader, is not ready (it can be started in Settings → Runtime)"
} satisfies Readonly<Record<BackendToolUnavailableReason, string>>)

/** Note a turn sends while tool calls are off. */
const TOOL_CALLS_OFF_NOTE =
  "Tool calls are turned off in Settings → Tools. If a request needs a tool you are not offered, say that tool calls are turned off and can be turned on in Settings → Tools; do not guess what a tool would return or claim to have used one."

/** Notes of a turn whose person switched tool calls off. */
const TOOL_CALLS_OFF_NOTES: readonly string[] = Object.freeze([
  TOOL_CALLS_OFF_NOTE
])

/**
 * Answers whether a turn tells the model about a tool it does not offer.
 *
 * @param unofferedTools - What the request names about the tools the turn
 * does not offer.
 * @returns True when tool calls are off, or when the request names a
 * switched-off or an unavailable tool.
 */
export function hasUnofferedToolNote(unofferedTools: UnofferedTools): boolean {
  if (unofferedTools.status === "tool-calls-off") return true
  return (
    unofferedTools.switchedOffToolNames.length > 0 ||
    unofferedTools.unavailableTools.length > 0
  )
}

/**
 * Lists the notes the model reads after its instructions about the tools a
 * turn does not offer.
 *
 * @param unofferedTools - What the request names about those tools.
 * @returns A frozen list: one note saying tool calls are off when they are;
 * otherwise a note naming the switched-off tools when any is, then a note
 * naming each unavailable tool with why it cannot run and what fixes it when
 * any is, each name in request order; empty when there is nothing to say.
 * Each note asks the model to say why a needed tool cannot be used instead
 * of guessing what it would return.
 */
export function listUnofferedToolNotes(
  unofferedTools: UnofferedTools
): readonly string[] {
  if (unofferedTools.status === "tool-calls-off") return TOOL_CALLS_OFF_NOTES
  const notes: string[] = []
  if (unofferedTools.switchedOffToolNames.length > 0)
    notes.push(formatSwitchedOffToolNote(unofferedTools.switchedOffToolNames))
  if (unofferedTools.unavailableTools.length > 0)
    notes.push(formatUnavailableToolNote(unofferedTools.unavailableTools))
  return Object.freeze(notes)
}

/**
 * Finds what the model reads when it called a tool the turn does not offer
 * because the request names it.
 *
 * @param unofferedTools - What the request names about the tools the turn
 * does not offer.
 * @param toolName - Name the call gives, which no offered tool has.
 * @returns While tool calls are off, a sentence saying the call did not run
 * because they are off, whatever the name; otherwise a sentence saying the
 * named tool is switched off, or that it is on but cannot run now, why, and
 * what fixes it; undefined when the request does not name the tool.
 */
export function findUnofferedToolCallMessage(
  unofferedTools: UnofferedTools,
  toolName: string
): string | undefined {
  if (unofferedTools.status === "tool-calls-off")
    return `"${toolName}" did not run: tool calls are turned off in Settings → Tools. Say that tool calls are turned off instead of guessing what it would return.`
  if (unofferedTools.switchedOffToolNames.includes(toolName))
    return `"${toolName}" is turned off in Settings → Tools, so it did not run. Say that it is turned off instead of guessing what it would return.`
  const unavailableTool = unofferedTools.unavailableTools.find(
    (tool) => tool.name === toolName
  )
  if (unavailableTool === undefined) return undefined
  return `"${toolName}" did not run: it is turned on but cannot run now, because ${UNAVAILABLE_TOOL_CLAUSES[unavailableTool.reason]}. Say why it cannot run instead of guessing what it would return.`
}

/**
 * Formats the note naming the tools the person switched off.
 *
 * @param switchedOffToolNames - At least one name, in request order.
 * @returns One paragraph naming the tools and asking the model to say a
 * needed one is off and where to turn it on.
 */
function formatSwitchedOffToolNote(
  switchedOffToolNames: readonly string[]
): string {
  const toolNames = switchedOffToolNames.join(", ")
  return `These tools are turned off in Settings → Tools, so you cannot call them now: ${toolNames}. If a request needs one of them, say that it is turned off and can be turned on in Settings → Tools; do not guess what it would return or claim to have used it.`
}

/**
 * Formats the note naming the switched-on tools that cannot run now.
 *
 * @param unavailableTools - At least one tool, in request order.
 * @returns One paragraph naming each tool with why it cannot run and what
 * fixes it, and asking the model to say so when a request needs one.
 */
function formatUnavailableToolNote(
  unavailableTools: readonly UnavailableBackendTool[]
): string {
  const toolReasons = unavailableTools
    .map(
      (tool) => `${tool.name}, because ${UNAVAILABLE_TOOL_CLAUSES[tool.reason]}`
    )
    .join("; ")
  return `These tools are turned on in Settings → Tools but cannot run now, so you cannot call them: ${toolReasons}. If a request needs one of them, say that it cannot run now, why, and what would fix that; do not guess what it would return or claim to have used it.`
}
