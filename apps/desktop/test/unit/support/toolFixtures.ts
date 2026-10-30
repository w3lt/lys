import { chatReplyEventSchema, type ChatToolCall } from "@lys/protocol"
import {
  buildMcpToolNamePrefix,
  toolDefinitionSchema,
  type LysToolDefinition,
  type McpToolDefinition,
  type ToolArgumentDefinitionCandidate,
  type ToolDefinitionCandidate
} from "@lys/share"
import { createFixtureUuidV7 } from "./conversationFixtures"

/**
 * Validates a definition of one of Lys's own tools.
 *
 * @param candidate - Definition whose runner is `client` or `backend`.
 * @returns The frozen definition the shared schema returns.
 * @throws {Error} When the candidate describes an MCP tool, which is a
 * mistake in the fixture.
 */
function parseLysToolDefinition(
  candidate: ToolDefinitionCandidate
): LysToolDefinition {
  const definition = toolDefinitionSchema.parse(candidate)
  if (definition.runner === "mcp") {
    throw new Error("The fixture describes an MCP tool, not one of Lys's own.")
  }
  return definition
}

/**
 * Builds one client tool definition as the desktop lists it: a tool that
 * reads files on this machine.
 *
 * @param name - Name a model calls the tool by.
 * @param toolArguments - Arguments the tool declares; defaults to one
 * required string `path`.
 * @returns A frozen definition validated by the shared schema.
 */
export function buildToolDefinition(
  name: string,
  toolArguments: readonly ToolArgumentDefinitionCandidate[] = [
    { type: "string", name: "path", description: "Absolute file path." }
  ]
): LysToolDefinition {
  return parseLysToolDefinition({
    name,
    description: `Runs ${name}.`,
    group: "files",
    access: "reads",
    runner: "client",
    arguments: toolArguments
  })
}

/**
 * Builds one backend tool definition as the backend lists it: a tool that
 * sends requests off this machine.
 *
 * @param name - Name a model calls the tool by.
 * @returns A frozen definition validated by the shared schema, with one
 * required string `url` argument.
 */
export function buildBackendToolDefinition(name: string): LysToolDefinition {
  return parseLysToolDefinition({
    name,
    description: `Runs ${name} in the backend.`,
    group: "network",
    access: "network",
    runner: "backend",
    arguments: [
      { type: "string", name: "url", description: "Address of the page." }
    ]
  })
}

/**
 * Input schema an MCP tool has by default: a required string `query` with a
 * description and an optional integer `limit` without one.
 */
const SEARCH_INPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    query: { type: "string", description: "Text to look for." },
    limit: { type: "integer" }
  },
  required: ["query"]
})

/**
 * Builds one MCP tool definition as the backend lists it for a connected
 * server.
 *
 * @param serverName - Name of the server that runs the tool.
 * @param serverToolName - Name the server calls the tool by; it must also
 * be a valid tool name, since it is used unchanged after the prefix.
 * @param inputSchema - Schema of the tool's arguments object; defaults to
 * {@link SEARCH_INPUT_SCHEMA}.
 * @returns A frozen definition validated by the shared schema, named
 * `mcp__<server>__<tool>`.
 */
export function buildMcpToolDefinition(
  serverName: string,
  serverToolName: string,
  inputSchema: unknown = SEARCH_INPUT_SCHEMA
): McpToolDefinition {
  const definition = toolDefinitionSchema.parse({
    name: `${buildMcpToolNamePrefix(serverName)}${serverToolName}`,
    description: `Runs ${serverToolName} on ${serverName}.`,
    group: "mcp",
    access: "unknown",
    runner: "mcp",
    server: serverName,
    serverToolName,
    inputSchema
  })
  if (definition.runner !== "mcp") {
    throw new Error("The fixture describes one of Lys's own tools.")
  }
  return definition
}

/**
 * Arguments of a call to a tool that declares the one `path` argument
 * {@link buildToolDefinition} gives a tool by default.
 */
const PATH_CALL_ARGUMENTS: ChatToolCall["arguments"] = Object.freeze({
  path: "/notes/todo.md"
})

/**
 * Builds one tool call the backend asks the desktop to answer.
 *
 * @param sequence - Identity sequence of the call's UUIDv7; keep it distinct
 * from the message sequences of the same case.
 * @param toolName - Name of the offered tool the model called.
 * @param callArguments - Argument values as the model sent them; defaults to
 * {@link PATH_CALL_ARGUMENTS}.
 * @returns A frozen call validated by the shared `tool-call` event schema.
 */
export function buildToolCall(
  sequence: number,
  toolName: string,
  callArguments: ChatToolCall["arguments"] = PATH_CALL_ARGUMENTS
): ChatToolCall {
  const call = Object.freeze({
    id: createFixtureUuidV7(sequence),
    toolName,
    arguments: Object.freeze({ ...callArguments })
  })
  chatReplyEventSchema.parse({ type: "tool-call", call })
  return call
}
