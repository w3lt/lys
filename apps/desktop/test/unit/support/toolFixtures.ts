import { chatReplyEventSchema, type ChatToolCall } from "@lys/protocol"
import {
  toolDefinitionSchema,
  type ToolArgumentDefinitionCandidate,
  type ToolDefinition
} from "@lys/share"
import { createFixtureUuidV7 } from "./conversationFixtures"

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
): ToolDefinition {
  return toolDefinitionSchema.parse({
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
export function buildBackendToolDefinition(name: string): ToolDefinition {
  return toolDefinitionSchema.parse({
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
 * Builds one tool call the backend asks the desktop to answer, with the
 * `path` argument that {@link buildToolDefinition} declares by default.
 *
 * @param sequence - Identity sequence of the call's UUIDv7; keep it distinct
 * from the message sequences of the same case.
 * @param toolName - Name of the offered tool the model called.
 * @returns A frozen call validated by the shared `tool-call` event schema.
 */
export function buildToolCall(
  sequence: number,
  toolName: string
): ChatToolCall {
  const call = Object.freeze({
    id: createFixtureUuidV7(sequence),
    toolName,
    arguments: Object.freeze({ path: "/notes/todo.md" })
  })
  chatReplyEventSchema.parse({ type: "tool-call", call })
  return call
}
