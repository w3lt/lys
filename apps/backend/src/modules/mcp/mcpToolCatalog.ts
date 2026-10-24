import {
  MAXIMUM_MCP_SERVER_TOOL_COUNT,
  type SkippedMcpTool,
  type SkippedMcpToolReason
} from "@lys/protocol"
import {
  buildMcpToolNamePrefix,
  isWithinJsonValueLimits,
  MAXIMUM_MCP_SERVER_TOOL_NAME_LENGTH,
  MAXIMUM_MCP_TOOL_DESCRIPTION_LENGTH,
  toolDefinitionSchema,
  toolNameSchema,
  type McpServerName,
  type McpToolDefinition
} from "@lys/share"
import type { Tool } from "@modelcontextprotocol/client"
import { formatCutText } from "../tool/builtIn/web/untrustedText"
import { formatVisibleText } from "../tool/networkToolResult"

/**
 * The tools of one connected server, as the backend lists them.
 *
 * @remarks `definitions` and `skippedTools` together hold every tool the
 * backend read, at most {@link MAXIMUM_MCP_SERVER_TOOL_COUNT}, each in the
 * server's order.
 */
export type McpToolCatalog = Readonly<{
  /** Tools the model can be offered, each model-facing name once. */
  definitions: readonly McpToolDefinition[]
  /** Tools read but not listed, and why. */
  skippedTools: readonly SkippedMcpTool[]
  /** Whether the server has more tools than the backend reads. */
  isToolListCut: boolean
}>

/** Outcome of turning one server tool into a definition. */
type McpToolEntry =
  | Readonly<{
      /** The tool is listed. */
      status: "listed"
      /** Its validated definition. */
      definition: McpToolDefinition
    }>
  | Readonly<{
      /** The tool is not listed. */
      status: "skipped"
      /** Why not. */
      reason: SkippedMcpToolReason
    }>

/**
 * Most bytes of an MCP tool's input schema, as UTF-8 JSON, inclusive.
 *
 * @remarks Each listed tool's schema is sent with every request that offers
 * it and takes room in the model's context; a larger schema is skipped.
 */
const MAXIMUM_INPUT_SCHEMA_BYTES = 64 * 1024

/** Finds each character the model-facing tool name rule does not allow. */
const UNSUPPORTED_TOOL_NAME_CHARACTER_PATTERN = /[^A-Za-z0-9_-]/gu

/** Character that replaces each one the tool name rule does not allow. */
const TOOL_NAME_REPLACEMENT = "_"

/** Character that ends a description cut short. */
const DESCRIPTION_ELLIPSIS = "…"

/**
 * Builds the tools the backend lists for one connected server.
 *
 * @param serverName - Name of the server.
 * @param tools - Every tool the server listed, in its order; untrusted.
 * @returns A frozen catalog of the first
 * {@link MAXIMUM_MCP_SERVER_TOOL_COUNT} tools. Each tool is listed, or
 * skipped with a reason: `unsupported-name` when its name is empty or longer
 * than {@link MAXIMUM_MCP_SERVER_TOOL_NAME_LENGTH} characters or the
 * model-facing name is longer than 64 characters; `duplicate-name` when an
 * earlier tool has the same model-facing name; `unsupported-input-schema`
 * when its input schema is not one Lys sends; `input-schema-too-large` when
 * that schema is larger than 64 KiB as JSON.
 * @remarks The model-facing name is `mcp__<server>__` followed by the
 * server's name for the tool, each character outside `[A-Za-z0-9_-]`
 * replaced by `_`. The description is the tool's own, else its title, else
 * a sentence naming the tool and the server; it is cleaned of characters a
 * person cannot see and cut to {@link MAXIMUM_MCP_TOOL_DESCRIPTION_LENGTH}
 * characters with `…`.
 */
export function buildMcpToolCatalog(
  serverName: McpServerName,
  tools: readonly Tool[]
): McpToolCatalog {
  const prefix = buildMcpToolNamePrefix(serverName)
  const definitions: McpToolDefinition[] = []
  const skippedTools: SkippedMcpTool[] = []
  const listedNames = new Set<string>()
  for (const tool of tools.slice(0, MAXIMUM_MCP_SERVER_TOOL_COUNT)) {
    const entry = buildMcpToolEntry(serverName, prefix, tool, listedNames)
    if (entry.status === "listed") {
      definitions.push(entry.definition)
      listedNames.add(entry.definition.name)
    } else {
      skippedTools.push(
        Object.freeze({
          name: formatSkippedToolName(tool.name),
          reason: entry.reason
        })
      )
    }
  }
  return Object.freeze({
    definitions: Object.freeze(definitions),
    skippedTools: Object.freeze(skippedTools),
    isToolListCut: tools.length > MAXIMUM_MCP_SERVER_TOOL_COUNT
  })
}

/**
 * Turns one server tool into a definition, or says why it is skipped.
 *
 * @param serverName - Name of the server.
 * @param prefix - `mcp__<server>__`.
 * @param tool - Untrusted tool the server listed.
 * @param listedNames - Model-facing names of the server's tools listed so
 * far.
 * @returns `listed` with the validated definition, or `skipped` with the
 * reason, checked in the order the reasons are documented.
 */
function buildMcpToolEntry(
  serverName: McpServerName,
  prefix: string,
  tool: Tool,
  listedNames: ReadonlySet<string>
): McpToolEntry {
  const name =
    prefix +
    tool.name.replace(
      UNSUPPORTED_TOOL_NAME_CHARACTER_PATTERN,
      TOOL_NAME_REPLACEMENT
    )
  if (
    tool.name.length === 0 ||
    tool.name.length > MAXIMUM_MCP_SERVER_TOOL_NAME_LENGTH ||
    !toolNameSchema.safeParse(name).success
  )
    return buildSkippedEntry("unsupported-name")
  if (listedNames.has(name)) return buildSkippedEntry("duplicate-name")
  if (!isWithinJsonValueLimits(tool.inputSchema))
    return buildSkippedEntry("unsupported-input-schema")
  if (
    Buffer.byteLength(JSON.stringify(tool.inputSchema)) >
    MAXIMUM_INPUT_SCHEMA_BYTES
  )
    return buildSkippedEntry("input-schema-too-large")
  const parsed = toolDefinitionSchema.safeParse({
    name,
    description: formatToolDescription(serverName, tool),
    group: "mcp",
    access: "unknown",
    runner: "mcp",
    server: serverName,
    serverToolName: tool.name,
    inputSchema: tool.inputSchema
  })
  if (!parsed.success || parsed.data.runner !== "mcp")
    return buildSkippedEntry("unsupported-input-schema")
  return Object.freeze({ status: "listed", definition: parsed.data })
}

/**
 * Builds the entry of a skipped tool.
 *
 * @param reason - Why it is skipped.
 * @returns A frozen `skipped` entry.
 */
function buildSkippedEntry(reason: SkippedMcpToolReason): McpToolEntry {
  return Object.freeze({ status: "skipped", reason })
}

/**
 * Formats the description the model and Settings show for one tool.
 *
 * @param serverName - Name of the server.
 * @param tool - Untrusted tool the server listed.
 * @returns The first of the tool's description, its title, and its
 * annotations' title that is not blank once cleaned of characters a person
 * cannot see and trimmed; else a sentence naming the tool and the server. Cut to
 * {@link MAXIMUM_MCP_TOOL_DESCRIPTION_LENGTH} characters, `…` included,
 * without splitting a character.
 */
function formatToolDescription(serverName: McpServerName, tool: Tool): string {
  const candidates = [tool.description, tool.title, tool.annotations?.title]
  const description =
    candidates
      .map((candidate) =>
        candidate === undefined ? "" : formatVisibleText(candidate).trim()
      )
      .find((candidate) => candidate !== "") ??
    `Tool ${formatSkippedToolName(tool.name)} of the MCP server ${serverName}.`
  if (description.length <= MAXIMUM_MCP_TOOL_DESCRIPTION_LENGTH)
    return description
  return (
    formatCutText(description, MAXIMUM_MCP_TOOL_DESCRIPTION_LENGTH - 1) +
    DESCRIPTION_ELLIPSIS
  )
}

/**
 * Formats the server's name for a tool as Settings shows it.
 *
 * @param serverToolName - Untrusted name the server gave the tool.
 * @returns The name cleaned of characters a person cannot see and cut to
 * {@link MAXIMUM_MCP_SERVER_TOOL_NAME_LENGTH} characters without splitting a
 * character; may be empty.
 */
function formatSkippedToolName(serverToolName: string): string {
  return formatCutText(
    formatVisibleText(serverToolName),
    MAXIMUM_MCP_SERVER_TOOL_NAME_LENGTH
  )
}
