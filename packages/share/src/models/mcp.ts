import * as z from "zod"
import { hasDistinctValues } from "./values"

/**
 * Most MCP servers the `mcp` settings group may hold, inclusive.
 *
 * @remarks Every limit of this module is also checked by the desktop host,
 * in its own copy of these rules, when it loads the settings file. Changing
 * one changes which settings files load and requires a coordinated desktop
 * and backend release.
 */
export const MAXIMUM_MCP_SERVER_COUNT = 16

/** Most characters an MCP server name may have, inclusive. */
export const MAXIMUM_MCP_SERVER_NAME_LENGTH = 20

/** Most characters, counted as Unicode code points, of a stdio command. */
export const MAXIMUM_MCP_COMMAND_LENGTH = 1024

/** Most arguments a stdio command may have, inclusive. */
export const MAXIMUM_MCP_COMMAND_ARGUMENT_COUNT = 64

/** Most characters, counted as Unicode code points, of one command argument. */
export const MAXIMUM_MCP_COMMAND_ARGUMENT_LENGTH = 1024

/** Most environment variables a stdio server may set, inclusive. */
export const MAXIMUM_MCP_ENVIRONMENT_VARIABLE_COUNT = 32

/** Most characters, counted as Unicode code points, of one variable's value. */
export const MAXIMUM_MCP_ENVIRONMENT_VALUE_LENGTH = 4096

/** Most characters, counted as Unicode code points, of a server URL. */
export const MAXIMUM_MCP_SERVER_URL_LENGTH = 2048

/** Most HTTP headers a remote server may be sent, inclusive. */
export const MAXIMUM_MCP_HEADER_COUNT = 32

/** Most characters of one header value, inclusive. */
export const MAXIMUM_MCP_HEADER_VALUE_LENGTH = 8192

/**
 * Finds an MCP server name: lowercase ASCII letters and digits in runs
 * joined by single hyphens, without a hyphen at either end.
 *
 * @remarks No underscore, so `mcp__<server>__<tool>` splits back into the
 * server and the tool.
 */
const MCP_SERVER_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Finds an environment variable name: an ASCII letter or underscore, then
 * up to 127 ASCII letters, digits, or underscores.
 */
const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[A-Za-z_]\w{0,127}$/

/**
 * Finds an HTTP header name: 1 to 128 characters of an RFC 9110 token.
 */
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/

/**
 * Finds a header value: visible ASCII characters, spaces, and tabs, not
 * starting or ending with a space or a tab.
 *
 * @remarks Fetch refuses characters past U+00FF and strips white space at
 * either end, so the value is sent exactly as saved.
 */
const HEADER_VALUE_PATTERN = /^(?:[!-~](?:[\t !-~]*[!-~])?)?$/

/** Finds a control character (Unicode general category Cc), such as a line break. */
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u

/** Finds white space or a control character. */
const SPACE_OR_CONTROL_PATTERN = /[\p{White_Space}\p{Cc}]/u

/** Finds white space at the start or the end of a text. */
const EDGE_WHITE_SPACE_PATTERN = /^\p{White_Space}|\p{White_Space}$/u

/**
 * Header names the HTTP transport sets itself, in lowercase; a server is
 * never sent another value for them.
 */
const TRANSPORT_HEADER_NAMES: ReadonlySet<string> = new Set([
  "accept",
  "content-length",
  "content-type",
  "host",
  "last-event-id",
  "mcp-protocol-version",
  "mcp-session-id"
])

/** Hosts a server URL may reach over plain `http:`. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]"
])

/**
 * Answers whether a text holds a control character other than a tab.
 *
 * @param value - Text to inspect.
 * @returns True when a line break or another control character is found.
 */
function hasControlCharacterOtherThanTab(value: string): boolean {
  return CONTROL_CHARACTER_PATTERN.test(value.replaceAll("\t", ""))
}

/**
 * Answers whether a text has at most a number of Unicode code points.
 *
 * @param value - Text to measure.
 * @param maximumLength - Most code points allowed, inclusive.
 * @returns True when the text is short enough.
 * @remarks Counts code points, as the desktop host counts characters.
 */
function hasCodePointsWithin(value: string, maximumLength: number): boolean {
  return [...value].length <= maximumLength
}

/**
 * Builds the schema of a text of 1 or more code points up to a limit,
 * without a control character other than a tab.
 *
 * @param maximumLength - Most code points allowed, inclusive.
 * @param message - What the rule is, for a refused value.
 * @returns A schema of such texts.
 */
function buildSettingTextSchema(
  maximumLength: number,
  message: string
): z.ZodString {
  return z
    .string()
    .refine(
      (value) =>
        hasCodePointsWithin(value, maximumLength) &&
        !hasControlCharacterOtherThanTab(value),
      message
    )
}

/**
 * Validates the name an MCP server is listed and its tools are named by:
 * 1 to {@link MAXIMUM_MCP_SERVER_NAME_LENGTH} lowercase ASCII letters and
 * digits, in runs joined by single hyphens.
 */
export const mcpServerNameSchema = z
  .string()
  .max(MAXIMUM_MCP_SERVER_NAME_LENGTH)
  .regex(
    MCP_SERVER_NAME_PATTERN,
    "An MCP server name is lowercase letters and digits, with single hyphens between them."
  )

/** Name of one MCP server. */
export type McpServerName = z.infer<typeof mcpServerNameSchema>

/**
 * Validates the command that starts a stdio server: 1 to
 * {@link MAXIMUM_MCP_COMMAND_LENGTH} code points, no control character, no
 * white space at either end.
 */
const mcpCommandSchema = buildSettingTextSchema(
  MAXIMUM_MCP_COMMAND_LENGTH,
  `A command is 1 to ${MAXIMUM_MCP_COMMAND_LENGTH} characters, without line breaks or other control characters.`
)
  .min(1)
  .refine(
    (value) => !EDGE_WHITE_SPACE_PATTERN.test(value) && !value.includes("\t"),
    "A command has no space or tab at either end, and no tab."
  )

/**
 * Validates one argument of a stdio command: 1 to
 * {@link MAXIMUM_MCP_COMMAND_ARGUMENT_LENGTH} code points, no control
 * character other than a tab.
 */
const mcpCommandArgumentSchema = buildSettingTextSchema(
  MAXIMUM_MCP_COMMAND_ARGUMENT_LENGTH,
  `An argument is 1 to ${MAXIMUM_MCP_COMMAND_ARGUMENT_LENGTH} characters, without line breaks or other control characters.`
).min(1)

/**
 * Validates one environment variable a stdio server is started with. The
 * output is frozen; unknown fields are rejected.
 */
const mcpEnvironmentVariableSchema = z
  .strictObject({
    /** Variable name: an ASCII letter or underscore, then letters, digits, or underscores. */
    name: z
      .string()
      .regex(
        ENVIRONMENT_VARIABLE_NAME_PATTERN,
        "A variable name is up to 128 ASCII letters, digits, and underscores, not starting with a digit."
      ),
    /** Value, which may be a secret; empty is allowed. */
    value: buildSettingTextSchema(
      MAXIMUM_MCP_ENVIRONMENT_VALUE_LENGTH,
      `A variable's value is up to ${MAXIMUM_MCP_ENVIRONMENT_VALUE_LENGTH} characters, without line breaks or other control characters.`
    )
  })
  .readonly()

/** One environment variable a stdio server is started with. */
export type McpEnvironmentVariable = z.infer<
  typeof mcpEnvironmentVariableSchema
>

/**
 * Validates how Lys talks to an MCP server: `stdio` for a command it starts
 * and talks to over its standard input and output, `http` for a URL it sends
 * requests to over Streamable HTTP.
 *
 * @remarks Each server settings variant takes one value of it. Adding a
 * transport is a compatibility change for every consumer that branches on
 * it.
 */
export const mcpServerTransportSchema = z.enum(["stdio", "http"])

/** How Lys talks to an MCP server: a command it starts, or a URL. */
export type McpServerTransport = z.infer<typeof mcpServerTransportSchema>

/**
 * Validates the settings of a server Lys starts as a command and talks to
 * over its standard input and output. The output is frozen; unknown fields
 * are rejected.
 */
const mcpStdioServerSettingsSchema = z
  .strictObject({
    /** Name the server is listed and its tools are named by. */
    name: mcpServerNameSchema,
    /** Lys starts the server and talks to it over stdio. */
    transport: mcpServerTransportSchema.extract(["stdio"]),
    /** Program to run, found through `PATH` unless it is a path. */
    command: mcpCommandSchema,
    /** Arguments in order; omitted means none. */
    arguments: z
      .array(mcpCommandArgumentSchema)
      .max(MAXIMUM_MCP_COMMAND_ARGUMENT_COUNT)
      .default([])
      .readonly(),
    /** Variables added to the default environment, each name once; omitted means none. */
    environment: z
      .array(mcpEnvironmentVariableSchema)
      .max(MAXIMUM_MCP_ENVIRONMENT_VARIABLE_COUNT)
      .refine(
        (variables) =>
          hasDistinctValues(variables.map((variable) => variable.name)),
        "A server sets each environment variable once."
      )
      .default([])
      .readonly()
  })
  .readonly()

/**
 * Parses an absolute URL.
 *
 * @param value - URL text.
 * @returns The parsed URL, or undefined when the text is not an absolute
 * URL.
 */
function parseAbsoluteUrl(value: string): URL | undefined {
  try {
    return new URL(value)
  } catch {
    return undefined
  }
}

/**
 * Answers whether a URL text is one Lys may send MCP requests to.
 *
 * @param value - URL text, already free of white space and control
 * characters.
 * @returns True for an absolute `https:` URL, or an `http:` URL whose host
 * is `localhost`, `127.0.0.1`, or `[::1]`, with no user name, password, or
 * fragment.
 */
function isMcpServerUrl(value: string): boolean {
  const url = parseAbsoluteUrl(value)
  if (url === undefined || value.includes("#")) return false
  if (url.username !== "" || url.password !== "") return false
  if (url.protocol === "https:") return true
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)
}

/**
 * Validates the URL of a remote MCP server: at most
 * {@link MAXIMUM_MCP_SERVER_URL_LENGTH} code points, no white space or
 * control character, `https:` or loopback `http:`, without credentials or a
 * fragment.
 */
const mcpServerUrlSchema = z
  .string()
  .refine(
    (value) =>
      hasCodePointsWithin(value, MAXIMUM_MCP_SERVER_URL_LENGTH) &&
      !SPACE_OR_CONTROL_PATTERN.test(value),
    `A URL is up to ${MAXIMUM_MCP_SERVER_URL_LENGTH} characters, without spaces.`
  )
  .refine(
    isMcpServerUrl,
    "A URL starts with https://, or http:// for localhost, 127.0.0.1, or [::1], and has no user name, password, or #."
  )

/**
 * Validates one HTTP header sent to a remote server. The output is frozen;
 * unknown fields are rejected.
 */
const mcpHeaderSchema = z
  .strictObject({
    /** Header name: an HTTP token, not one the transport sets itself. */
    name: z
      .string()
      .regex(
        HEADER_NAME_PATTERN,
        "A header name is up to 128 letters, digits, and the characters !#$%&'*+.^_`|~-."
      )
      .refine(
        (name) => !TRANSPORT_HEADER_NAMES.has(name.toLowerCase()),
        "Lys sets this header itself."
      ),
    /** Value, which may be a secret such as a bearer token; empty is allowed. */
    value: z
      .string()
      .max(MAXIMUM_MCP_HEADER_VALUE_LENGTH)
      .regex(
        HEADER_VALUE_PATTERN,
        "A header value is visible ASCII characters, spaces, and tabs, with no space or tab at either end."
      )
  })
  .readonly()

/** One HTTP header sent to a remote server. */
export type McpHeader = z.infer<typeof mcpHeaderSchema>

/**
 * Validates the settings of a remote server Lys reaches over Streamable
 * HTTP. The output is frozen; unknown fields are rejected.
 */
const mcpHttpServerSettingsSchema = z
  .strictObject({
    /** Name the server is listed and its tools are named by. */
    name: mcpServerNameSchema,
    /** Lys sends MCP requests to the URL over Streamable HTTP. */
    transport: mcpServerTransportSchema.extract(["http"]),
    /** Endpoint of the server. */
    url: mcpServerUrlSchema,
    /** Headers sent with every request, each name once ignoring case; omitted means none. */
    headers: z
      .array(mcpHeaderSchema)
      .max(MAXIMUM_MCP_HEADER_COUNT)
      .refine(
        (headers) =>
          hasDistinctValues(headers.map((header) => header.name.toLowerCase())),
        "A server is sent each header once."
      )
      .default([])
      .readonly()
  })
  .readonly()

/**
 * Validates one MCP server of the `mcp` settings group.
 *
 * @remarks `transport` selects the variant: `stdio` for a command Lys
 * starts, `http` for a URL it sends requests to.
 */
export const mcpServerSettingsSchema = z.discriminatedUnion("transport", [
  mcpStdioServerSettingsSchema,
  mcpHttpServerSettingsSchema
])

/** One MCP server as the `mcp` settings group holds it. */
export type McpServerSettings = z.infer<typeof mcpServerSettingsSchema>

/** MCP server settings before validation; list fields may be omitted. */
export type McpServerSettingsCandidate = z.input<typeof mcpServerSettingsSchema>

/**
 * Validates the `mcp` settings group: the MCP servers Lys connects to, each
 * name once, in the order Settings lists them. The output is frozen; unknown
 * fields are rejected.
 *
 * @remarks An omitted list means no server. The desktop host is the only
 * writer of the group; the backend only reads it.
 */
export const mcpSettingsSchema = z
  .strictObject({
    /** Servers in list order. */
    servers: z
      .array(mcpServerSettingsSchema)
      .max(MAXIMUM_MCP_SERVER_COUNT)
      .refine(
        (servers) => hasDistinctValues(servers.map((server) => server.name)),
        "Each MCP server has its own name."
      )
      .default([])
      .readonly()
  })
  .readonly()

/** The `mcp` settings group. */
export type McpSettings = z.infer<typeof mcpSettingsSchema>

/** Start of every name the model calls an MCP tool by. */
export const MCP_TOOL_NAME_PREFIX = "mcp__"

/**
 * Builds the start of the names the model calls one server's tools by.
 *
 * @param serverName - Validated server name.
 * @returns `mcp__<server>__`; the server's tool name follows it.
 */
export function buildMcpToolNamePrefix(serverName: McpServerName): string {
  return `${MCP_TOOL_NAME_PREFIX}${serverName}__`
}
