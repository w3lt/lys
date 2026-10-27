import { MAXIMUM_MCP_SERVER_NAME_LENGTH } from "@lys/share"

import {
  buildMcpHttpDraft,
  buildMcpStdioDraft,
  type McpServerDraft
} from "./mcp-server-draft"

/** Why pasted text could not fill the editor. */
export type McpServerJsonProblem =
  | "not-json"
  | "not-object"
  | "no-servers"
  | "no-command-or-url"
  | "unreadable-values"
  | "sse"

/** Outcome of filling the editor from a pasted MCP config. */
export type McpServerJsonParse =
  | {
      /** The first server of the config filled the draft. */
      readonly status: "filled"
      /** Draft with the server's name, transport, and its fields filled. */
      readonly draft: McpServerDraft
      /** Number of servers the config holds; only the first is used. */
      readonly serverCount: number
    }
  | {
      /** The text is not a config Lys can read. */
      readonly status: "invalid"
      /** Why. */
      readonly problem: McpServerJsonProblem
    }

/** A JSON object of a pasted config, whose values are still untrusted. */
type ConfigObject = Readonly<Record<string, unknown>>

/** One name and its value, read from a config's map as text. */
type ConfigPair = {
  /** Name, as the config gives it. */
  readonly name: string
  /** Value, read as text. */
  readonly value: string
}

/** First server of a config, before it is read. */
type ConfigServer = {
  /** Key the config lists it under, or empty when the config is the server. */
  readonly key: string
  /** The server's config, still untrusted. */
  readonly config: ConfigObject
  /** Number of servers the config holds. */
  readonly serverCount: number
}

/** Keys a config may hold its servers under, in the order they are tried. */
const SERVER_MAP_KEYS = Object.freeze(["mcpServers", "servers", "mcp_servers"])

/** Keys that make an object one server's config. */
const SERVER_CONFIG_KEYS = Object.freeze(["command", "url", "serverUrl"])

/** Finds the characters a server name cannot hold. */
const NAME_SEPARATOR_PATTERN = /[^a-z0-9]+/u

/**
 * Builds a failed parse.
 *
 * @param problem - Why the text could not fill the editor.
 * @returns A frozen invalid outcome.
 */
function buildJsonProblem(problem: McpServerJsonProblem): McpServerJsonParse {
  return Object.freeze({ status: "invalid", problem })
}

/**
 * Reads pasted text as JSON.
 *
 * @param text - Text as pasted.
 * @returns The value, untrusted, or undefined when the text is not JSON.
 */
function readJson(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text)
    return value
  } catch {
    return undefined
  }
}

/**
 * Answers whether an untrusted value is a JSON object.
 *
 * @param value - Untrusted value.
 * @returns True for an object that is not an array or null.
 */
function isConfigObject(value: unknown): value is ConfigObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Answers whether an untrusted value is one server's config.
 *
 * @param value - Untrusted value.
 * @returns True for an object with a `command`, `url`, or `serverUrl` key.
 */
function isServerConfig(value: unknown): value is ConfigObject {
  return isConfigObject(value) && SERVER_CONFIG_KEYS.some((key) => key in value)
}

/**
 * Reads a config value that must be a string.
 *
 * @param value - Untrusted value.
 * @returns The string, or undefined for any other value.
 */
function readConfigString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

/**
 * Reads a config value given for an argument, a variable, or a header.
 *
 * @param value - Untrusted value.
 * @returns A string as it is, a number or a Boolean as text, or undefined
 * for any other value.
 */
function readConfigText(value: unknown): string | undefined {
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }
  return readConfigString(value)
}

/**
 * Answers whether a value was read as text.
 *
 * @param text - Text, or undefined when it could not be read.
 * @returns True for text.
 */
function isText(text: string | undefined): text is string {
  return text !== undefined
}

/**
 * Reads a config's list of arguments.
 *
 * @param value - Untrusted value of `args`.
 * @returns The arguments as text; none when `args` is absent; undefined when
 * it is not an array of texts, numbers, or Booleans.
 */
function readConfigArguments(value: unknown): readonly string[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value)) return undefined
  const items: readonly unknown[] = value
  const texts = items.map(readConfigText)
  return texts.every(isText) ? texts : undefined
}

/**
 * Reads a config's map of names and values.
 *
 * @param value - Untrusted value of `env` or `headers`.
 * @returns Each name and its value as text, in the config's order; none when
 * the map is absent; undefined when it is not an object of texts, numbers,
 * or Booleans.
 */
function readConfigPairs(value: unknown): readonly ConfigPair[] | undefined {
  if (value === undefined) return []
  if (!isConfigObject(value)) return undefined
  const pairs: ConfigPair[] = []
  for (const [name, item] of Object.entries(value)) {
    const text = readConfigText(item)
    if (text === undefined) return undefined
    pairs.push({ name, value: text })
  }
  return pairs
}

/**
 * Finds the first server of a map of servers by name.
 *
 * @param map - Untrusted map.
 * @returns The first server, or a problem when the map is not an object, is
 * empty, or its first entry is not a server's config.
 */
function findFirstMapServer(map: unknown): ConfigServer | McpServerJsonProblem {
  if (!isConfigObject(map)) return "no-servers"
  const entries = Object.entries(map)
  const [first] = entries
  if (first === undefined) return "no-servers"
  const [key, config] = first
  if (!isServerConfig(config)) return "no-command-or-url"
  return { key, config, serverCount: entries.length }
}

/**
 * Finds the first server of a config.
 *
 * @param object - Pasted object.
 * @returns The first server of `mcpServers`, `servers`, or `mcp_servers`;
 * the object itself when it is one server's config; the first entry of the
 * object when it is a map of server configs; otherwise a problem.
 */
function findConfigServer(
  object: ConfigObject
): ConfigServer | McpServerJsonProblem {
  const mapKey = SERVER_MAP_KEYS.find((key) => object[key] !== undefined)
  if (mapKey !== undefined) return findFirstMapServer(object[mapKey])
  if (isServerConfig(object)) {
    return { key: "", config: object, serverCount: 1 }
  }
  return findFirstMapServer(object)
}

/**
 * Formats a server name from the key a config lists the server under.
 *
 * @param key - Key as the config gives it.
 * @returns The key in lowercase, each run of characters a name cannot hold
 * replaced by one hyphen, without a hyphen at either end, cut to the
 * longest name; empty when nothing is left.
 */
export function formatMcpServerNameFromKey(key: string): string {
  const words = key
    .toLowerCase()
    .split(NAME_SEPARATOR_PATTERN)
    .filter((word) => word !== "")
  const name = words.join("-").slice(0, MAXIMUM_MCP_SERVER_NAME_LENGTH)
  return name.endsWith("-") ? name.slice(0, -1) : name
}

/**
 * Builds a draft from a URL server's config.
 *
 * @param draft - Draft to fill, with the name already chosen.
 * @param url - The config's URL.
 * @param config - The server's untrusted config.
 * @returns The filled draft; `sse` for a server whose `type` is `sse`, in
 * any case, a transport Lys does not speak; `unreadable-values` when its
 * headers are not texts. Only the type marks a server as SSE: a URL alone,
 * whatever its path, fills a Streamable HTTP server.
 */
function buildHttpConfigDraft(
  draft: McpServerDraft,
  url: string,
  config: ConfigObject
): McpServerDraft | McpServerJsonProblem {
  if (readConfigString(config.type)?.toLowerCase() === "sse") return "sse"
  const headers = readConfigPairs(config.headers)
  if (headers === undefined) return "unreadable-values"
  return buildMcpHttpDraft(draft, url, headers)
}

/**
 * Builds a draft from a command server's config.
 *
 * @param draft - Draft to fill, with the name already chosen.
 * @param command - The config's command.
 * @param config - The server's untrusted config.
 * @returns The filled draft, or `unreadable-values` when its arguments or
 * variables are not texts; a working directory is not read.
 */
function buildStdioConfigDraft(
  draft: McpServerDraft,
  command: string,
  config: ConfigObject
): McpServerDraft | McpServerJsonProblem {
  const commandArguments = readConfigArguments(config.args)
  const variables = readConfigPairs(config.env)
  if (commandArguments === undefined || variables === undefined) {
    return "unreadable-values"
  }
  return buildMcpStdioDraft(draft, command, commandArguments, variables)
}

/**
 * Builds a draft from one server's config.
 *
 * @param draft - Draft to fill, with the name already chosen.
 * @param config - The server's untrusted config, which has a `command`,
 * `url`, or `serverUrl` key.
 * @returns The filled draft: a URL server's when the config has a URL, a
 * command server's when it has a command; otherwise `unreadable-values`.
 */
function buildDraftFromConfig(
  draft: McpServerDraft,
  config: ConfigObject
): McpServerDraft | McpServerJsonProblem {
  const url = readConfigString(config.url) ?? readConfigString(config.serverUrl)
  if (url !== undefined) return buildHttpConfigDraft(draft, url, config)
  const command = readConfigString(config.command)
  if (command !== undefined)
    return buildStdioConfigDraft(draft, command, config)
  return "unreadable-values"
}

/**
 * Fills the editor's draft from a pasted MCP config.
 *
 * @param text - Pasted text, untrusted.
 * @param draft - Draft as it is now.
 * @returns The draft with the first server's name, when the config gives
 * one, its transport, and its fields, the other fields kept, and how many
 * servers the config holds; or why the text cannot fill it. A config is a
 * `mcpServers`, `servers`, or `mcp_servers` map, as in
 * `claude_desktop_config.json` or `.cursor/mcp.json`, a map of servers by
 * name, or one server. A URL server's `Authorization: Bearer` header
 * becomes the token.
 */
export function parseMcpServerJson(
  text: string,
  draft: McpServerDraft
): McpServerJsonParse {
  const value = readJson(text)
  if (value === undefined) return buildJsonProblem("not-json")
  if (!isConfigObject(value)) return buildJsonProblem("not-object")
  const server = findConfigServer(value)
  if (typeof server === "string") return buildJsonProblem(server)
  const name = formatMcpServerNameFromKey(server.key)
  const named = Object.freeze({
    ...draft,
    name: name === "" ? draft.name : name
  })
  const filled = buildDraftFromConfig(named, server.config)
  if (typeof filled === "string") return buildJsonProblem(filled)
  return Object.freeze({
    status: "filled",
    draft: filled,
    serverCount: server.serverCount
  })
}
