import type { ListedBackendToolUnavailableReason } from "@lys/protocol"
import {
  buildToolFunctionFormat,
  type JsonValue,
  type LysToolDefinition,
  type McpToolDefinition,
  type ToolAccess,
  type ToolArgumentDefinition,
  type ToolDefinition,
  type ToolRunner
} from "@lys/share"

import {
  estimateTextTokens,
  formatTokenCount
} from "@/components/ComposerComponents/composer-context"
import type { ToolModelSupport } from "@/lib/models/tool-model-support"
import {
  TOOL_APPROVALS,
  type ToolApproval,
  type ToolSettingsSaveState
} from "@/lib/store/tool-settings"
import { isToolOn } from "@/lib/store/tools"

/** Tone of the tool-calls status dot. */
export type ToolCallsTone = "neutral" | "active" | "warning"

/** Facts the tool-calls status line describes. */
export type ToolCallsSummary = {
  /** Whether agents may call tools at all. */
  readonly areToolCallsOn: boolean
  /** Whether the loaded model can be offered tools. */
  readonly support: ToolModelSupport
  /** Number of tools switched on. */
  readonly offeredToolCount: number
  /** Estimated tokens the switched-on tools add to each request. */
  readonly offeredTokenCount: number
}

/**
 * Tools listed under one group heading, in list order: one of Lys's groups,
 * or the tools of one MCP server.
 */
export type ToolGroupListing = {
  /**
   * Identity of the listing among the others: the group of Lys's tools, or
   * `mcp:` followed by the server's name.
   */
  readonly key: string
  /** Heading text: the group's lowercase label, or `MCP · <server>`. */
  readonly heading: string
  /** Tools of the group, at least one, in list order. */
  readonly tools: readonly ToolDefinition[]
}

/** One argument of a tool, as Settings lists it. */
export type ToolArgumentListing = {
  /** Name the model sends the argument by. */
  readonly name: string
  /** Type shown beside the name, such as `string`, `enum · 3`, or `JSON`. */
  readonly type: string
  /** Whether a model must send the argument. */
  readonly isRequired: boolean
  /** What the argument means, or undefined when the tool does not say. */
  readonly description: string | undefined
  /** Values an enum accepts, in offered order, or undefined for other types. */
  readonly values: readonly string[] | undefined
}

/** Tools switched on and what they add to each request. */
export type OfferedToolTotals = {
  /** Number of tools switched on. */
  readonly offeredToolCount: number
  /** Estimated tokens the switched-on tools add to each request. */
  readonly offeredTokenCount: number
}

/** Where a tool runs, as Settings and the approval card present it. */
export type ToolRunnerPresentation = {
  /** Lowercase badge text. */
  readonly label: string
  /** Tooltip of the badge. */
  readonly title: string
  /** Heading of the detail row in Settings. */
  readonly heading: string
  /** What the detail row says about where the tool runs. */
  readonly note: string
}

/** Note under an unavailable tool, by reason; a new reason must add one. */
const TOOL_UNAVAILABLE_NOTES = Object.freeze({
  "api-key-missing": "Needs a Tavily API key. Add one in Settings → Secrets.",
  "api-key-invalid":
    "The Tavily API key in settings.json isn't valid. Fix or remove secrets.tavilyApiKey in that file.",
  "settings-unreadable":
    "Lys couldn't read settings.json. Fix that file by hand.",
  "page-reader-not-ready":
    "vmo, Lys's page reader, isn't ready. See Settings → Runtime."
} satisfies Readonly<Record<ListedBackendToolUnavailableReason, string>>)

/**
 * Lowercase heading text of every group of Lys's own tools; a new group must
 * add one. MCP tools are listed per server instead.
 */
const TOOL_GROUP_LABELS = Object.freeze({
  files: "files",
  network: "web",
  timeAndPlace: "time & place",
  agents: "agents"
} satisfies Readonly<Record<LysToolDefinition["group"], string>>)

/** Lowercase badge text of every access level; a new level must add one. */
const TOOL_ACCESS_LABELS = Object.freeze({
  reads: "reads",
  network: "network",
  unknown: "depends on server"
} satisfies Readonly<Record<ToolAccess, string>>)

/** Type shown for an MCP argument whose schema names no single type. */
const MCP_ARGUMENT_JSON_TYPE = "JSON"

/**
 * What Just run does, by what the tool does with the machine; a new access
 * level must add one.
 */
const JUST_RUN_NOTES = Object.freeze({
  reads: "Runs the moment the model asks, without showing you the call.",
  network:
    "Sends its request off this machine the moment the model asks, without showing you what it sends.",
  unknown:
    "Runs on its MCP server the moment the model asks, without showing you what it sends. What it does depends on the MCP server."
} satisfies Readonly<Record<ToolAccess, string>>)

/** Presentation of every runner; a new runner must add one. */
const TOOL_RUNNER_PRESENTATIONS = Object.freeze({
  client: Object.freeze({
    label: "in Lys",
    title: "Runs inside the Lys app",
    heading: "Runs in Lys",
    note: "Handled by the Lys app on this machine. Works whichever runtime you point Lys at, and stops when you close Lys."
  }),
  backend: Object.freeze({
    label: "in backend",
    title: "Runs in Lys’s backend",
    heading: "Runs in Lys’s backend",
    note: "Handled by Lys’s backend, which sends the request from wherever it runs. Works while the backend runs."
  }),
  mcp: Object.freeze({
    label: "on MCP server",
    title: "Runs on an MCP server",
    heading: "Runs on an MCP server",
    note: "Lys’s backend sends each call to the tool’s MCP server, which does the work. Works while the backend runs and the server is connected."
  })
} satisfies Readonly<Record<ToolRunner, ToolRunnerPresentation>>)

/**
 * Calculates an estimate of the tokens a tool adds to each request it is
 * offered in.
 *
 * @param tool - Tool definition.
 * @returns The estimate for the function tool the model receives, which
 * varies with the model's tokenizer.
 */
export function calculateToolTokenEstimate(tool: ToolDefinition): number {
  return estimateTextTokens(JSON.stringify(buildToolFunctionFormat(tool)))
}

/**
 * Calculates how many tools are offered and what they add to a request.
 *
 * @param tools - Every listed tool.
 * @param toolSwitches - Saved switches the person changed, keyed by tool
 * name.
 * @param unavailableTools - Why each tool that cannot run now cannot, by
 * name; such a tool is never offered, whatever its switch says.
 * @returns The count and summed token estimate of the tools that are
 * switched on and can run now.
 */
export function calculateOfferedToolTotals(
  tools: readonly ToolDefinition[],
  toolSwitches: ReadonlyMap<string, boolean>,
  unavailableTools: ReadonlyMap<string, ListedBackendToolUnavailableReason>
): OfferedToolTotals {
  const offeredTools = tools.filter(
    (tool) => isToolOn(toolSwitches, tool) && !unavailableTools.has(tool.name)
  )
  const offeredTokenCount = offeredTools.reduce(
    (tokenCount, tool) => tokenCount + calculateToolTokenEstimate(tool),
    0
  )

  return Object.freeze({
    offeredToolCount: offeredTools.length,
    offeredTokenCount
  })
}

/**
 * Formats a token estimate for a tool row or the status line.
 *
 * @param tokenCount - Estimated tokens.
 * @returns A label such as `~108 tok`; the `~` marks an estimate.
 */
export function formatToolTokenEstimate(tokenCount: number): string {
  return `~${formatTokenCount(tokenCount)} tok`
}

/**
 * Formats the line under the tool-calls heading.
 *
 * @param summary - Switch state, model support, and the switched-on tools.
 * @returns What agents are offered: nothing while tool calls are off or the
 * model was not trained for them, and otherwise the count and token estimate,
 * after the model's key when a model is loaded.
 */
export function formatToolCallsStatus(summary: ToolCallsSummary): string {
  if (!summary.areToolCallsOn) {
    return "agents answer from the prompt alone · nothing is offered"
  }

  const offer = `${summary.offeredToolCount} offered · ${formatToolTokenEstimate(summary.offeredTokenCount)} per request`
  switch (summary.support.status) {
    case "unknown":
      return offer
    case "trained":
      return `${summary.support.modelKey} · ${offer}`
    case "untrained":
      return `${summary.support.modelKey} isn't trained for tool calls · nothing is offered`
  }
}

/**
 * Calculates the tone of the tool-calls status dot.
 *
 * @param areToolCallsOn - Whether agents may call tools.
 * @param support - Whether the loaded model can be offered tools.
 * @returns `neutral` while tool calls are off, `warning` while the loaded
 * model was not trained for them, and `active` otherwise.
 */
export function calculateToolCallsTone(
  areToolCallsOn: boolean,
  support: ToolModelSupport
): ToolCallsTone {
  if (!areToolCallsOn) return "neutral"

  return support.status === "untrained" ? "warning" : "active"
}

/** Heading of one group listing, by the key that identifies it. */
type ToolGroupIdentity = Pick<ToolGroupListing, "key" | "heading">

/**
 * Builds the identity of the group listing a tool belongs to.
 *
 * @param tool - Listed tool.
 * @returns For one of Lys's tools, its group and the group's lowercase
 * label; for an MCP tool, `mcp:<server>` and `MCP · <server>`.
 */
function buildToolGroupIdentity(tool: ToolDefinition): ToolGroupIdentity {
  if (tool.runner === "mcp") {
    return { key: `mcp:${tool.server}`, heading: `MCP · ${tool.server}` }
  }
  return { key: tool.group, heading: TOOL_GROUP_LABELS[tool.group] }
}

/**
 * Builds the group listings of the tools, keeping list order.
 *
 * @param tools - Every listed tool, in list order.
 * @returns One frozen listing per group of Lys's tools and per MCP server,
 * in the order each first appears, with its tools in list order. MCP tools
 * follow Lys's own in the list, so their servers' listings come last.
 */
export function buildToolGroups(
  tools: readonly ToolDefinition[]
): readonly ToolGroupListing[] {
  const listings = new Map<
    string,
    ToolGroupIdentity & { tools: ToolDefinition[] }
  >()
  for (const tool of tools) {
    const identity = buildToolGroupIdentity(tool)
    const listing = listings.get(identity.key)
    if (listing === undefined)
      listings.set(identity.key, { ...identity, tools: [tool] })
    else listing.tools.push(tool)
  }

  return Object.freeze(
    [...listings.values()].map((listing) =>
      Object.freeze({ ...listing, tools: Object.freeze(listing.tools) })
    )
  )
}

/**
 * Formats the count beside a tool group's heading.
 *
 * @param onToolCount - Number of the group's tools switched on.
 * @param toolCount - Number of the group's tools.
 * @returns A label such as `1 of 2 on`.
 */
export function formatToolGroupCount(
  onToolCount: number,
  toolCount: number
): string {
  return `${onToolCount} of ${toolCount} on`
}

/**
 * Formats the badge that says what a tool does with the machine.
 *
 * @param access - Access level of the tool.
 * @returns The badge's lowercase text.
 */
export function formatToolAccessLabel(access: ToolAccess): string {
  return TOOL_ACCESS_LABELS[access]
}

/**
 * Gets how Settings and the approval card present where a tool runs.
 *
 * @param runner - Side that runs the tool.
 * @returns The badge text and tooltip, and the detail row's heading and note.
 */
export function getToolRunnerPresentation(
  runner: ToolRunner
): ToolRunnerPresentation {
  return TOOL_RUNNER_PRESENTATIONS[runner]
}

/**
 * Formats the type of one argument of one of Lys's tools.
 *
 * @param argument - Argument definition.
 * @returns The JSON type, or `enum · N` for an enum with N values.
 */
function formatToolArgumentType(argument: ToolArgumentDefinition): string {
  switch (argument.type) {
    case "enum":
      return `enum · ${argument.values.length}`
    case "string":
    case "number":
    case "integer":
    case "boolean":
      return argument.type
  }
}

/**
 * Formats whether a model must supply one argument.
 *
 * @param isRequired - Whether the argument is required.
 * @returns `required` or `optional`.
 */
export function formatToolArgumentRequirement(isRequired: boolean): string {
  return isRequired ? "required" : "optional"
}

/**
 * Lists the arguments of one of Lys's tools.
 *
 * @param tool - Lys tool definition.
 * @returns One listing per declared argument, in declaration order.
 */
function listLysToolArguments(
  tool: LysToolDefinition
): readonly ToolArgumentListing[] {
  return tool.arguments.map((argument) => buildLysArgumentListing(argument))
}

/**
 * Builds the listing of one argument of one of Lys's tools.
 *
 * @param argument - Declared argument.
 * @returns A frozen listing with its type, requirement, description, and an
 * enum's values.
 */
function buildLysArgumentListing(
  argument: ToolArgumentDefinition
): ToolArgumentListing {
  return Object.freeze({
    name: argument.name,
    type: formatToolArgumentType(argument),
    isRequired: argument.required,
    description: argument.description,
    values: argument.type === "enum" ? argument.values : undefined
  })
}

/** A JSON object, read-only. */
type JsonObject = Readonly<{ [key: string]: JsonValue }>

/**
 * Answers whether a JSON value is an object.
 *
 * @param value - JSON value.
 * @returns True for an object that is not an array.
 */
function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Reads one text keyword of an MCP argument's schema.
 *
 * @param schema - Schema of the argument, any JSON value.
 * @param keyword - Keyword to read, such as `type`.
 * @returns The keyword's value when the schema is an object holding text
 * under it as its own key, otherwise undefined.
 */
function readSchemaText(
  schema: JsonValue,
  keyword: string
): string | undefined {
  if (!isJsonObject(schema) || !Object.hasOwn(schema, keyword)) return undefined
  const value = schema[keyword]
  return typeof value === "string" ? value : undefined
}

/**
 * Lists the arguments of an MCP tool from its input schema.
 *
 * @param tool - MCP tool definition.
 * @returns One listing per property of the input schema, in the schema's
 * order: its type when the property names one type as text, otherwise
 * `JSON`; required when the schema's `required` names it; its description
 * when it has one as text. An enum's values are not listed.
 */
function listMcpToolArguments(
  tool: McpToolDefinition
): readonly ToolArgumentListing[] {
  const { properties = {}, required = [] } = tool.inputSchema
  return Object.entries(properties).map(([name, schema]) =>
    buildMcpArgumentListing(name, schema, required.includes(name))
  )
}

/**
 * Builds the listing of one argument of an MCP tool.
 *
 * @param name - Argument name.
 * @param schema - The argument's schema, any JSON value.
 * @param isRequired - Whether the input schema's `required` names it.
 * @returns A frozen listing: its type when the schema names one type as
 * text, otherwise `JSON`, and its description when it has one as text.
 */
function buildMcpArgumentListing(
  name: string,
  schema: JsonValue,
  isRequired: boolean
): ToolArgumentListing {
  return Object.freeze({
    name,
    type: readSchemaText(schema, "type") ?? MCP_ARGUMENT_JSON_TYPE,
    isRequired,
    description: readSchemaText(schema, "description"),
    values: undefined
  })
}

/**
 * Lists the arguments of a tool as Settings shows them.
 *
 * @param tool - Tool definition.
 * @returns A frozen list: the declared arguments of one of Lys's tools, or
 * the properties of an MCP tool's input schema, in order.
 */
export function listToolArguments(
  tool: ToolDefinition
): readonly ToolArgumentListing[] {
  return Object.freeze(
    tool.runner === "mcp"
      ? listMcpToolArguments(tool)
      : listLysToolArguments(tool)
  )
}

/**
 * Formats how many of a tool's arguments are required and optional.
 *
 * @param toolArguments - Arguments of one tool, as Settings lists them.
 * @returns `none` without arguments, otherwise the non-zero counts such as
 * `3 required · 2 optional`.
 */
export function formatToolArgumentCounts(
  toolArguments: readonly ToolArgumentListing[]
): string {
  if (toolArguments.length === 0) return "none"

  const requiredCount = toolArguments.filter(
    (argument) => argument.isRequired
  ).length
  const optionalCount = toolArguments.length - requiredCount
  const counts: string[] = []
  if (requiredCount > 0) counts.push(`${requiredCount} required`)
  if (optionalCount > 0) counts.push(`${optionalCount} optional`)

  return counts.join(" · ")
}

/**
 * Formats the label of one approval choice.
 *
 * @param approval - When a tool runs once the model asks for it.
 * @returns `Ask me` or `Just run`.
 */
export function formatToolApprovalLabel(approval: ToolApproval): string {
  switch (approval) {
    case "ask":
      return "Ask me"
    case "run":
      return "Just run"
  }
}

/**
 * Formats what happens before a tool runs under one approval.
 *
 * @param approval - When the tool runs once the model asks for it.
 * @param access - What the tool does with the machine.
 * @returns A sentence describing the approval; for Just run it says what
 * leaves the machine unseen when the tool sends requests off it.
 */
export function formatToolApprovalNote(
  approval: ToolApproval,
  access: ToolAccess
): string {
  switch (approval) {
    case "ask":
      return "Each call waits for you with its arguments. Nothing runs until you allow it."
    case "run":
      return JUST_RUN_NOTES[access]
  }
}

/**
 * Formats the outcome of the latest save of the tool choices.
 *
 * @param save - Latest application-owned save lifecycle state.
 * @returns The saving or failure message, or an empty string while idle or
 * after a successful save, which leave nothing to announce. The failure
 * message says that each switch still applies, because the desktop builds
 * each request's offer, while Just run follows the saved choices, because
 * the backend reads them from the settings file.
 */
export function formatToolSettingsSaveStatus(
  save: ToolSettingsSaveState
): string {
  switch (save.status) {
    case "saving":
      return "Saving tool choices…"
    case "failed":
      return "Couldn't save your tool choices. Each switch applies until Lys quits, but Just run keeps following the choices Lys last saved until a save works."
    case "idle":
    case "saved":
      return ""
  }
}

/**
 * Finds the approval a toggle group selected.
 *
 * @param groupValue - Pressed item values the toggle group reports.
 * @returns The selected approval, or `undefined` when the group reports no
 * offered approval, as when the pressed item is pressed again.
 */
export function findToolApproval(
  groupValue: readonly string[]
): ToolApproval | undefined {
  return TOOL_APPROVALS.find((approval) => groupValue.includes(approval))
}

/**
 * Formats why a tool cannot run now.
 *
 * @param reason - Why the backend says it cannot run.
 * @returns One sentence with what to do.
 */
export function formatToolUnavailableNote(
  reason: ListedBackendToolUnavailableReason
): string {
  return TOOL_UNAVAILABLE_NOTES[reason]
}

/**
 * Determines whether the Secrets pane fixes why a tool cannot run.
 *
 * @param reason - Why the backend says it cannot run.
 * @returns True only for a missing key. An invalid key or an unreadable
 * settings file is fixed in settings.json by hand: the desktop cannot load
 * either at startup, and a save from the pane would replace the file with the
 * settings it loaded earlier. A page reader that isn't ready is started in
 * the Runtime pane.
 */
export function isFixedInSecretsPane(
  reason: ListedBackendToolUnavailableReason
): boolean {
  return reason === "api-key-missing"
}
