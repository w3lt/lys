import {
  hasDistinctValues,
  MAXIMUM_MCP_SERVER_COUNT,
  MAXIMUM_MCP_SERVER_TOOL_NAME_LENGTH,
  mcpServerNameSchema,
  mcpServerTransportSchema
} from "@lys/share"
import * as z from "zod"

/**
 * Most tools the backend reads from one MCP server, inclusive: each is
 * listed or skipped, and the rest are not read.
 *
 * @remarks Bounds the tools one server adds to the tool list and to every
 * request that offers them. Raising it requires a coordinated backend and
 * desktop release.
 */
export const MAXIMUM_MCP_SERVER_TOOL_COUNT = 128

/**
 * Validates why an MCP server is not connected.
 *
 * @remarks `start-failed`: the command could not be started. `closed`: the
 * process exited or the connection ended, such as when a URL server answers
 * a call with HTTP 404 because it no longer knows the session. `timed-out`:
 * the server did not finish connecting and listing its tools in time.
 * `unauthorized`: the server answered HTTP 401 or 403. `unreachable`: no
 * connection could be made, such as a refused connection or an unknown host.
 * `http-error`: the server answered another HTTP error or a redirect, which
 * Lys refuses. `protocol-error`: the server's answers are not valid MCP or
 * longer than the backend reads, or it answered the connection or the tool
 * list with an error. Adding a reason is a compatibility change for every
 * consumer that branches on it.
 */
export const mcpServerFailureSchema = z.enum([
  "start-failed",
  "closed",
  "timed-out",
  "unauthorized",
  "unreachable",
  "http-error",
  "protocol-error"
])

/** Why an MCP server is not connected. */
export type McpServerFailure = z.infer<typeof mcpServerFailureSchema>

/**
 * Validates why the backend does not list one tool of a connected server.
 *
 * @remarks `unsupported-name`: the server's name for the tool is empty,
 * longer than {@link MAXIMUM_MCP_SERVER_TOOL_NAME_LENGTH} characters, or
 * holds a character a person cannot see, or the name the model would call it
 * by is longer than 64 characters.
 * `duplicate-name`: another tool of the server is called by the same name
 * once characters outside the tool-name rule are replaced.
 * `unsupported-input-schema`: its input schema is not an object schema,
 * names an argument outside the argument-name rule, nests too deep, holds
 * a `__proto__` key, or holds a character a person cannot see in a key or a
 * text. `input-schema-too-large`: its input schema is larger
 * than the backend sends. Adding a reason is a compatibility change for
 * every consumer that branches on it.
 */
export const skippedMcpToolReasonSchema = z.enum([
  "unsupported-name",
  "duplicate-name",
  "unsupported-input-schema",
  "input-schema-too-large"
])

/** Why the backend does not list one tool of a connected server. */
export type SkippedMcpToolReason = z.infer<typeof skippedMcpToolReasonSchema>

/**
 * Validates one tool of a connected server that the backend does not list.
 * The output is frozen; unknown fields are rejected.
 */
const skippedMcpToolSchema = z
  .strictObject({
    /** The server's name for the tool, cut to its first characters; may be empty. */
    name: z.string().max(MAXIMUM_MCP_SERVER_TOOL_NAME_LENGTH),
    /** Why it is not listed. */
    reason: skippedMcpToolReasonSchema
  })
  .readonly()

/** One tool of a connected server that the backend does not list. */
export type SkippedMcpTool = z.infer<typeof skippedMcpToolSchema>

/**
 * Validates the connection state of one MCP server.
 *
 * @remarks `connecting`: the backend is starting or reaching the server and
 * reading its tools. `connected`: its tools are listed; `toolCount` tools
 * are listed and `skippedTools` read but not listed, together at most
 * {@link MAXIMUM_MCP_SERVER_TOOL_COUNT}, and `isToolListCut` says the server
 * has tools past that. `failed`: the server is not connected and why;
 * Reconnect or a changed setting tries again.
 */
export const mcpServerStateSchema = z
  .discriminatedUnion("status", [
    z.strictObject({ status: z.literal("connecting") }),
    z
      .strictObject({
        status: z.literal("connected"),
        /** Tools the backend lists for the server. */
        toolCount: z.int().min(0).max(MAXIMUM_MCP_SERVER_TOOL_COUNT),
        /** Tools read but not listed, in the server's order. */
        skippedTools: z
          .array(skippedMcpToolSchema)
          .max(MAXIMUM_MCP_SERVER_TOOL_COUNT)
          .readonly(),
        /** Whether the server has more tools than the backend reads. */
        isToolListCut: z.boolean()
      })
      .refine(
        (state) =>
          state.toolCount + state.skippedTools.length <=
          MAXIMUM_MCP_SERVER_TOOL_COUNT,
        `A connected server lists and skips at most ${MAXIMUM_MCP_SERVER_TOOL_COUNT} tools together.`
      ),
    z.strictObject({
      status: z.literal("failed"),
      /** Why the server is not connected. */
      reason: mcpServerFailureSchema
    })
  ])
  .readonly()

/** Connection state of one MCP server. */
export type McpServerState = z.infer<typeof mcpServerStateSchema>

/**
 * Validates one applied MCP server and its state, without its settings. The
 * output is frozen; unknown fields are rejected.
 *
 * @remarks It never carries a command, an argument, an environment
 * variable, a URL, or a header, which can hold secrets.
 */
const mcpServerStatusSchema = z
  .strictObject({
    /** Name of the server. */
    name: mcpServerNameSchema,
    /** How the backend talks to it. */
    transport: mcpServerTransportSchema,
    /** Its connection state. */
    state: mcpServerStateSchema
  })
  .readonly()

/** One applied MCP server and its state. */
export type McpServerStatus = z.infer<typeof mcpServerStatusSchema>

/**
 * Validates the MCP servers the backend applied, with each one's state. The
 * output is frozen.
 *
 * @remarks `settings` is the outcome of the backend's last read of the `mcp`
 * settings group: `applied` when it applied the group, or found no file or
 * no group, which means no server; `invalid` when the group failed its
 * rules; `unreadable` when the settings file could not be read as a JSON
 * object. After `invalid` or `unreadable` the backend keeps the servers it
 * applied before, which `servers` lists, in the group's order.
 */
export const mcpServerListSchema = z
  .strictObject({
    /** Outcome of the last read of the `mcp` settings group. */
    settings: z.enum(["applied", "invalid", "unreadable"]),
    /** Applied servers in the group's order, each name once. */
    servers: z
      .array(mcpServerStatusSchema)
      .max(MAXIMUM_MCP_SERVER_COUNT)
      .refine(
        (servers) => hasDistinctValues(servers.map((server) => server.name)),
        "The backend lists each MCP server once."
      )
      .readonly()
  })
  .readonly()

/** The MCP servers the backend applied, with each one's state. */
export type McpServerList = z.infer<typeof mcpServerListSchema>

/**
 * Validates the body of a sync or reconnect request: an empty JSON object,
 * sent as `application/json`.
 *
 * @remarks Each request starts or reaches servers. Its body is required so
 * that a page in the person's browser cannot send it from another origin: a
 * request with a JSON body needs a CORS preflight, which the backend refuses
 * for every origin but the desktop's, and a body sent without a preflight,
 * such as a form or plain text, fails this schema before anything starts.
 */
export const mcpServerActionBodySchema = z.strictObject({}).readonly()

/** Body of a sync or reconnect request: an empty JSON object. */
export type McpServerActionBody = z.infer<typeof mcpServerActionBodySchema>

/**
 * Validates the path parameters that address one applied MCP server.
 *
 * @remarks A malformed name is rejected before any lookup, so it never
 * produces a not-found problem.
 */
export const mcpServerPathParamsSchema = z
  .strictObject({
    /** Name of the addressed server, compared exactly. */
    serverName: mcpServerNameSchema
  })
  .readonly()

/** Path parameters addressing one applied MCP server. */
export type McpServerPathParams = z.infer<typeof mcpServerPathParamsSchema>
