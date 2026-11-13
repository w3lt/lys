import { toolDefinitionSchema, type ToolDefinition } from "@lys/share"
import { buildAgentStateDefinitions } from "../../../src/modules/agent/agentStateTools"
import type { ToolSearchOutcome } from "../../../src/modules/agent/findToolsTool"
import AgentTool from "../../../src/modules/tool/tool"

/**
 * Validated definition of the desktop's read-text-file tool: one required
 * string argument, `path`.
 */
export const READ_TEXT_FILE_TOOL: ToolDefinition = toolDefinitionSchema.parse({
  name: "read_text_file",
  description: "Read one UTF-8 text file and return its complete text.",
  group: "files",
  access: "reads",
  runner: "client",
  arguments: [
    { type: "string", name: "path", description: "Absolute path of the file." }
  ]
})

/** Function tool a model is offered for {@link READ_TEXT_FILE_TOOL}. */
export const READ_TEXT_FILE_FORMAT = Object.freeze({
  type: "function",
  function: {
    name: "read_text_file",
    description: "Read one UTF-8 text file and return its complete text.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path of the file." }
      },
      required: ["path"],
      additionalProperties: false
    }
  }
})

/**
 * Names of the state tools a built-in agent, a leader, offers a model trained
 * for tool use, after every other tool of the turn.
 */
export const LEADER_STATE_TOOL_NAMES: readonly string[] = Object.freeze([
  "read_my_state",
  "find_agents",
  "read_agent_state"
])

/** Function tools a leader's state tools are offered as, in offer order. */
export const LEADER_STATE_TOOL_FORMATS = Object.freeze(
  buildAgentStateDefinitions("leader").map((definition) =>
    new AgentTool(definition).buildAgentFormat()
  )
)

/**
 * Builds the definition of a backend tool that reaches the network and takes
 * no argument.
 *
 * @param name - Name of the tool.
 * @param description - What the tool does.
 * @returns The validated definition, in the `network` group.
 */
export function buildNetworkToolDefinition(
  name: string,
  description: string
): ToolDefinition {
  return toolDefinitionSchema.parse({
    name,
    description,
    group: "network",
    access: "network",
    runner: "backend",
    arguments: []
  })
}

/**
 * Builds tools that all match the word `note`.
 *
 * @param count - Number of tools; a non-negative integer.
 * @returns Tools named `note_1` up, in order, each described as
 * `Keeps a note.`.
 */
export function buildNoteTools(count: number): readonly ToolDefinition[] {
  return Array.from({ length: count }, (_unused, index) =>
    buildNetworkToolDefinition(`note_${index + 1}`, "Keeps a note.")
  )
}

/**
 * Builds the outcome of a search that ran to its end, as a keeper returns
 * it.
 *
 * @param toolNames - Names of the tools found, in the order found; copied.
 * @returns A frozen `found` outcome over a frozen copy of the names.
 */
export function buildFoundToolSearchOutcome(
  toolNames: readonly string[]
): ToolSearchOutcome {
  const foundNames = Object.freeze([...toolNames])
  return Object.freeze({ status: "found", toolNames: foundNames })
}
