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
import {
  SdkError,
  SdkErrorCode,
  specTypeSchemas,
  type Tool
} from "@modelcontextprotocol/client"
import { formatCutText } from "../tool/builtIn/web/untrustedText"
import { formatVisibleText } from "../tool/networkToolResult"

/**
 * The tools of one connected server, as the backend lists them.
 *
 * @remarks `definitions` and `skippedTools` together hold every tool the
 * backend checked, at most {@link MAXIMUM_MCP_SERVER_TOOL_COUNT}, each in the
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

/** One listed tool after the SDK's tool schema checked it. */
type CheckedMcpTool = Readonly<{
  /**
   * The tool as the schema reads it; its input schema is
   * {@link PLACEHOLDER_INPUT_SCHEMA} when the server's is past the JSON
   * value limits.
   */
  tool: Tool
  /** Whether the server's input schema is within the JSON value limits. */
  isInputSchemaWithinLimits: boolean
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

/**
 * Input schema the SDK's tool schema checks in place of one nested past the
 * JSON value limits.
 */
const PLACEHOLDER_INPUT_SCHEMA = Object.freeze({ type: "object" })

/** Finds each character the model-facing tool name rule does not allow. */
const UNSUPPORTED_TOOL_NAME_CHARACTER_PATTERN = /[^A-Za-z0-9_-]/gu

/** Character that replaces each one the tool name rule does not allow. */
const TOOL_NAME_REPLACEMENT = "_"

/** Character that ends a description cut short. */
const DESCRIPTION_ELLIPSIS = "…"

/**
 * Builds the tools the backend lists for one connected server, one listed
 * tool at a time, so that only the tools it keeps stay in memory.
 *
 * @remarks Each tool the server listed is checked and turned into a
 * definition or a skipped entry as it is added; the server's own object is
 * not kept. The catalog holds the first {@link MAXIMUM_MCP_SERVER_TOOL_COUNT}
 * tools; adding one more marks the list as cut and is otherwise ignored.
 * Resource ownership: owns the definitions and skipped entries until
 * {@link build} copies them. Concurrency model: single caller, which awaits
 * each {@link addTool} before the next.
 */
export default class McpToolCatalogBuilder {
  /** Name of the server. */
  readonly #serverName: McpServerName
  /** `mcp__<server>__`, the start of every model-facing name. */
  readonly #prefix: string
  /** Tools listed so far, in the server's order. */
  readonly #definitions: McpToolDefinition[]
  /** Tools skipped so far, in the server's order. */
  readonly #skippedTools: SkippedMcpTool[]
  /** Model-facing names of the tools listed so far. */
  readonly #listedNames: Set<string>
  /** Whether a tool was added after the catalog was full. */
  #isToolListCut: boolean

  /**
   * Creates an empty catalog.
   *
   * @param serverName - Name of the server whose tools are added.
   */
  public constructor(serverName: McpServerName) {
    this.#serverName = serverName
    this.#prefix = buildMcpToolNamePrefix(serverName)
    this.#definitions = []
    this.#skippedTools = []
    this.#listedNames = new Set()
    this.#isToolListCut = false
  }

  /**
   * Whether the server listed more tools than the catalog holds.
   *
   * @returns True once a tool was added to a full catalog.
   */
  public get isToolListCut(): boolean {
    return this.#isToolListCut
  }

  /**
   * Checks one tool the server listed and adds it, listed or skipped.
   *
   * @param rawTool - Untrusted tool, in the server's order.
   * @returns A promise that settles once the tool was added. Each tool is
   * listed, or skipped with a reason: `unsupported-name` when its name is
   * empty, longer than {@link MAXIMUM_MCP_SERVER_TOOL_NAME_LENGTH}
   * characters, or holds a character a person cannot see, or the
   * model-facing name is longer than 64 characters; `duplicate-name` when
   * an earlier tool has the same model-facing name;
   * `unsupported-input-schema` when its input schema is not one Lys sends,
   * nests deeper than the JSON value limits, or holds a character a person
   * cannot see in any key or text; `input-schema-too-large` when that
   * schema is larger than 64 KiB as JSON. A tool added to a full catalog is
   * not checked; it marks the list as cut.
   * @throws The SDK's invalid-result error when the tool is not one the
   * MCP tool schema allows, as the SDK's own list read would throw; see
   * {@link checkListedTool}.
   * @remarks The model-facing name is `mcp__<server>__` followed by the
   * server's name for the tool, each character outside `[A-Za-z0-9_-]`
   * replaced by `_`. The description is the tool's own, else its title,
   * else its annotations' title, else a sentence naming the tool and the
   * server; it is cleaned of characters a person cannot see and cut to
   * {@link MAXIMUM_MCP_TOOL_DESCRIPTION_LENGTH} characters with `…`. The
   * name and the input schema are sent as the server wrote them, so a tool
   * is listed only when both are text a person can see: what the model
   * reads and what the approval prompt and Settings show are then the same.
   */
  public async addTool(rawTool: unknown): Promise<void> {
    const toolCount = this.#definitions.length + this.#skippedTools.length
    if (toolCount >= MAXIMUM_MCP_SERVER_TOOL_COUNT) {
      this.#isToolListCut = true
      return
    }
    const checkedTool = await checkListedTool(rawTool)
    const entry = buildMcpToolEntry(
      this.#serverName,
      this.#prefix,
      checkedTool,
      this.#listedNames
    )
    if (entry.status === "listed") {
      this.#definitions.push(entry.definition)
      this.#listedNames.add(entry.definition.name)
    } else {
      this.#skippedTools.push(
        Object.freeze({
          name: formatSkippedToolName(checkedTool.tool.name),
          reason: entry.reason
        })
      )
    }
  }

  /**
   * Builds the catalog of the tools added so far.
   *
   * @returns A frozen catalog that later additions do not change.
   */
  public build(): McpToolCatalog {
    return Object.freeze({
      definitions: Object.freeze([...this.#definitions]),
      skippedTools: Object.freeze([...this.#skippedTools]),
      isToolListCut: this.#isToolListCut
    })
  }
}

/**
 * Checks one listed tool against the SDK's tool schema, as the SDK checks
 * every tool of a list it reads itself, after bounding what that schema
 * checks recursively.
 *
 * @param rawTool - Untrusted tool the server listed.
 * @returns The tool as the schema reads it, and whether the server's input
 * schema is within the JSON value limits.
 * @throws The SDK's invalid-result error when the schema refuses the tool.
 * @remarks The SDK's schema checks the properties of an input schema
 * recursively, so one nested thousands of levels deep would exhaust the
 * stack. An input schema past the JSON value limits is checked as
 * {@link PLACEHOLDER_INPUT_SCHEMA} instead, and the tool is then skipped.
 * The schema checks no other part of a tool recursively.
 */
async function checkListedTool(rawTool: unknown): Promise<CheckedMcpTool> {
  const isInputSchemaWithinLimits =
    typeof rawTool !== "object" ||
    rawTool === null ||
    !("inputSchema" in rawTool) ||
    isWithinJsonValueLimits(rawTool.inputSchema)
  const outcome = await specTypeSchemas.Tool["~standard"].validate(
    isInputSchemaWithinLimits
      ? rawTool
      : { ...rawTool, inputSchema: PLACEHOLDER_INPUT_SCHEMA }
  )
  if (outcome.issues !== undefined)
    throw new SdkError(
      SdkErrorCode.InvalidResult,
      "Invalid result for tools/list: a tool does not match the MCP tool schema."
    )
  return Object.freeze({ tool: outcome.value, isInputSchemaWithinLimits })
}

/**
 * Turns one server tool into a definition, or says why it is skipped.
 *
 * @param serverName - Name of the server.
 * @param prefix - `mcp__<server>__`.
 * @param checkedTool - Tool the server listed, after the SDK's schema
 * checked it; still untrusted.
 * @param listedNames - Model-facing names of the server's tools listed so
 * far.
 * @returns `listed` with the validated definition, or `skipped` with the
 * reason, checked in the order the reasons are documented.
 */
function buildMcpToolEntry(
  serverName: McpServerName,
  prefix: string,
  checkedTool: CheckedMcpTool,
  listedNames: ReadonlySet<string>
): McpToolEntry {
  const { tool } = checkedTool
  const name =
    prefix +
    tool.name.replace(
      UNSUPPORTED_TOOL_NAME_CHARACTER_PATTERN,
      TOOL_NAME_REPLACEMENT
    )
  const skippedReason = findSkippedToolReason(name, checkedTool, listedNames)
  if (skippedReason !== undefined) return buildSkippedEntry(skippedReason)
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
 * Finds why one server tool is skipped before its definition is checked.
 *
 * @param name - Model-facing name of the tool.
 * @param checkedTool - Tool the server listed, after the SDK's schema
 * checked it; still untrusted.
 * @param listedNames - Model-facing names of the server's tools listed so
 * far.
 * @returns The first reason that applies, in the order the reasons are
 * documented; undefined when none does.
 */
function findSkippedToolReason(
  name: string,
  checkedTool: CheckedMcpTool,
  listedNames: ReadonlySet<string>
): SkippedMcpToolReason | undefined {
  const { tool } = checkedTool
  if (
    !isSupportedServerToolName(tool.name) ||
    !toolNameSchema.safeParse(name).success
  )
    return "unsupported-name"
  if (listedNames.has(name)) return "duplicate-name"
  if (
    !checkedTool.isInputSchemaWithinLimits ||
    !isWithinJsonValueLimits(tool.inputSchema) ||
    !isVisibleJsonValue(tool.inputSchema)
  )
    return "unsupported-input-schema"
  if (
    Buffer.byteLength(JSON.stringify(tool.inputSchema)) >
    MAXIMUM_INPUT_SCHEMA_BYTES
  )
    return "input-schema-too-large"
  return undefined
}

/**
 * Answers whether the server's name for a tool is one Lys lists.
 *
 * @param serverToolName - Untrusted name the server gave the tool.
 * @returns Whether it is 1 to {@link MAXIMUM_MCP_SERVER_TOOL_NAME_LENGTH}
 * characters and holds no character a person cannot see, so the approval
 * prompt and Settings show the name the call sends.
 */
function isSupportedServerToolName(serverToolName: string): boolean {
  return (
    serverToolName.length > 0 &&
    serverToolName.length <= MAXIMUM_MCP_SERVER_TOOL_NAME_LENGTH &&
    isVisibleText(serverToolName)
  )
}

/**
 * Answers whether a JSON value holds only text a person can see.
 *
 * @param value - Untrusted JSON value, already checked to nest within the
 * JSON value limits.
 * @returns Whether every key and every string in it, at any depth, holds no
 * character {@link formatVisibleText} removes.
 */
function isVisibleJsonValue(value: unknown): boolean {
  if (typeof value === "string") return isVisibleText(value)
  if (Array.isArray(value)) return value.every(isVisibleJsonValue)
  if (typeof value !== "object" || value === null) return true
  return Object.entries(value).every(
    ([key, item]) => isVisibleText(key) && isVisibleJsonValue(item)
  )
}

/**
 * Answers whether text holds only characters a person can see.
 *
 * @param text - Untrusted text.
 * @returns Whether {@link formatVisibleText} leaves it unchanged.
 */
function isVisibleText(text: string): boolean {
  return formatVisibleText(text) === text
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
 * @param tool - Untrusted tool the server listed, whose name holds only
 * characters a person can see.
 * @returns The first of the tool's description, its title, and its
 * annotations' title that is not blank once cleaned of characters a person
 * cannot see and trimmed; else a sentence naming the tool and the server. Cut to
 * {@link MAXIMUM_MCP_TOOL_DESCRIPTION_LENGTH} characters, `…` included,
 * without splitting a character, in a string of its own.
 */
function formatToolDescription(serverName: McpServerName, tool: Tool): string {
  const candidates = [tool.description, tool.title, tool.annotations?.title]
  const description =
    candidates
      .map((candidate) =>
        candidate === undefined ? "" : formatVisibleText(candidate).trim()
      )
      .find((candidate) => candidate !== "") ??
    `Tool ${tool.name} of the MCP server ${serverName}.`
  if (description.length <= MAXIMUM_MCP_TOOL_DESCRIPTION_LENGTH)
    return copyText(description)
  return copyText(
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
 * character, in a string of its own; may be empty.
 */
function formatSkippedToolName(serverToolName: string): string {
  return copyText(
    formatCutText(
      formatVisibleText(serverToolName),
      MAXIMUM_MCP_SERVER_TOOL_NAME_LENGTH
    )
  )
}

/**
 * Copies text into a string of its own.
 *
 * @param text - Text cut or trimmed out of an untrusted server text.
 * @returns The same UTF-16 code units, lone surrogates included, in a new
 * string.
 * @remarks V8 can keep a string cut out of a longer one as a view into
 * that one, so a description cut to 4,096 characters out of a 16 MiB one
 * would keep the 16 MiB for as long as the catalog lives. Encoding the
 * code units and decoding them again makes a string that refers to
 * nothing else.
 */
function copyText(text: string): string {
  return Buffer.from(text, "utf16le").toString("utf16le")
}
