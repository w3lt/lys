import type {
  AgentNotFoundProblem,
  ChatApiRequestBody,
  ChatToolOffer,
  ConversationAgentMissingProblem,
  ConversationIsJobProblem,
  ConversationNotFoundProblem
} from "@lys/protocol"
import { DELEGATE_WORK_TOOL_NAME, MCP_TOOL_NAME_PREFIX } from "@lys/share"
import type { FastifyReply } from "fastify"
import type Agent from "../../agent/agent"
import {
  createAgentNotFoundProblem,
  createConversationAgentMissingProblem
} from "../../agent/routes/agentProblems"
import {
  NO_UNOFFERED_TOOLS,
  TOOL_CALLS_OFF,
  type UnofferedTools
} from "../../agent/unofferedTools"
import { createConversationIsJobProblem } from "../../conversation/routes/jobProblem"
import { createConversationNotFoundProblem } from "../../conversation/routes/notFound"
import type {
  McpTurnToolLookup,
  TurnMcpTool
} from "../../mcp/mcpServerRegistry"
import type { BuiltInToolEntry } from "../../tool/builtIn/builtInTool"
import { findBuiltInTools } from "../../tool/builtIn/builtInTools"

/** Lookups that find the agent answering a requested turn. */
export type TurnAgentLookups = Readonly<{
  /**
   * Live agent loading of the agent runtime service; undefined means no
   * built-in or stored agent has the code, or its agent is deleted.
   */
  loadChatAgent: (code: string) => Agent | undefined
  /**
   * Agent code lookup of a stored conversation; undefined means the
   * conversation is not stored.
   */
  findConversationAgentCode: (conversationId: string) => string | undefined
}>

/**
 * Request naming a backend tool the backend does not run, mapped by
 * Fastify to a caller-safe HTTP 400.
 *
 * @remarks The subclass preserves the native `Error` contract and always
 * reports status 400. It owns no mutable state and is constructed once per
 * rejected request.
 */
export class UnknownBackendToolError extends Error {
  /**
   * Creates the error for one request.
   *
   * @param toolNames - Names the request offers as backend tools, or names
   * as backend tools that cannot run now, that belong to no backend tool.
   */
  public constructor(toolNames: readonly string[]) {
    super(
      `The request names backend tools the backend does not run: ${toolNames.join(", ")}`
    )
  }

  /**
   * HTTP status consumed by Fastify's error boundary.
   *
   * @returns The invalid-input status.
   */
  public get statusCode(): number {
    return 400
  }
}

/** Outcome of looking up the agent that answers a requested turn. */
export type RequestedAgentOutcome =
  | Readonly<{
      /** An agent answers the turn. */
      status: "found"
      /** Agent that answers, with the system prompt it has now. */
      agent: Agent
    }>
  | Readonly<{
      /** A new conversation names a code no built-in or stored agent has. */
      status: "agent-not-found"
      /** Code the request names. */
      agentCode: string
    }>
  | Readonly<{
      /** The continued conversation is not stored. */
      status: "conversation-not-found"
      /** Identifier the request names. */
      conversationId: string
    }>
  | Readonly<{
      /** The agent of the continued conversation no longer exists. */
      status: "conversation-agent-missing"
      /** Code stored with the conversation. */
      agentCode: string
    }>

/**
 * Outcome of looking up the agent that answers a requested turn when the
 * lookup found none.
 */
export type MissingRequestedAgentOutcome = Exclude<
  RequestedAgentOutcome,
  Readonly<{ status: "found" }>
>

/**
 * Outcome of the person's message to a job: the chat route refuses it before
 * it looks up an agent.
 */
type ConversationIsJobOutcome = Readonly<{
  /**
   * The continued conversation is a job, which the person reads and stops
   * and does not write into.
   */
  status: "conversation-is-job"
  /** Identifier the request names. */
  conversationId: string
}>

/**
 * Outcome in which no agent answers the requested turn: the agent lookup
 * found none, or the person's message continues a job.
 */
type UnansweredTurnOutcome =
  MissingRequestedAgentOutcome | ConversationIsJobOutcome

/** The backend tools a request offers, by kind, in offer order. */
export type RequestedBackendTools = Readonly<{
  /** Offered built-in tools; empty when none. */
  builtInTools: readonly BuiltInToolEntry[]
  /** Offered MCP tools whose server is connected; empty when none. */
  mcpTools: readonly TurnMcpTool[]
  /**
   * Name of the first offered MCP tool whose server is applied but not
   * connected now; undefined when there is none.
   */
  notConnectedMcpToolName: string | undefined
  /**
   * Whether the request offers `delegate_work`. The tool is in neither list:
   * the agent adds it itself to a turn that may delegate.
   */
  offersDelegateWork: boolean
}>

/**
 * Finds the backend tools a request offers: the built-in tools, and the
 * tools of the MCP servers, whose names start with `mcp__`; and whether it
 * offers `delegate_work`.
 *
 * @param builtInTools - Every built-in tool.
 * @param findMcpTool - Looks up one MCP tool in the servers as they are
 * now.
 * @param tools - Validated tool offer of the request; absence offers none.
 * @returns The offered tools by kind, each list in offer order, the first
 * offered MCP tool whose server is not connected, and whether the offer
 * names `delegate_work`. That name is taken out before the lookups, so it is
 * looked up among neither the built-in tools nor the servers' tools.
 * @throws An {@link UnknownBackendToolError} naming every other offered
 * name, in offer order, that belongs to no built-in tool and to no applied
 * server's listed tool.
 */
export function findRequestedBackendTools(
  builtInTools: readonly BuiltInToolEntry[],
  findMcpTool: (toolName: string) => McpTurnToolLookup,
  tools: ChatToolOffer | undefined
): RequestedBackendTools {
  const builtInByName = new Map(
    builtInTools.map((entry) => [entry.definition.name, entry])
  )
  const offeredNames = tools?.backendToolNames ?? []
  const lookedUpNames = offeredNames.filter(
    (name) => name !== DELEGATE_WORK_TOOL_NAME
  )
  const offeredBuiltInTools: BuiltInToolEntry[] = []
  const otherNames: string[] = []
  for (const name of lookedUpNames) {
    const builtInTool = builtInByName.get(name)
    if (builtInTool === undefined) otherNames.push(name)
    else offeredBuiltInTools.push(builtInTool)
  }
  const offeredMcpTools = findOfferedMcpTools(otherNames, findMcpTool)
  if (offeredMcpTools.unknownNames.length > 0)
    throw new UnknownBackendToolError(offeredMcpTools.unknownNames)
  return Object.freeze({
    builtInTools: Object.freeze(offeredBuiltInTools),
    mcpTools: offeredMcpTools.tools,
    notConnectedMcpToolName: offeredMcpTools.notConnectedToolName,
    offersDelegateWork: offeredNames.includes(DELEGATE_WORK_TOOL_NAME)
  })
}

/** The MCP tools among a request's offered names that are not built in. */
type OfferedMcpTools = Readonly<{
  /** Offered tools whose server is connected, in offer order. */
  tools: readonly TurnMcpTool[]
  /**
   * Name of the first offered tool whose server is applied but not
   * connected now; undefined when there is none.
   */
  notConnectedToolName: string | undefined
  /**
   * Names, in offer order, that belong to no applied server's listed tool;
   * a name without the `mcp__` prefix is always among them.
   */
  unknownNames: readonly string[]
}>

/**
 * Finds the MCP tools among offered names that belong to no built-in tool.
 *
 * @param names - Offered names that belong to no built-in tool, in offer
 * order.
 * @param findMcpTool - Looks up one MCP tool in the servers as they are
 * now; called only for names with the `mcp__` prefix.
 * @returns The found tools, the first name whose server is not connected,
 * and the names no server has, each in offer order.
 */
function findOfferedMcpTools(
  names: readonly string[],
  findMcpTool: (toolName: string) => McpTurnToolLookup
): OfferedMcpTools {
  const tools: TurnMcpTool[] = []
  const unknownNames: string[] = []
  let notConnectedToolName: string | undefined
  for (const name of names) {
    const lookup: McpTurnToolLookup = name.startsWith(MCP_TOOL_NAME_PREFIX)
      ? findMcpTool(name)
      : { status: "unknown" }
    switch (lookup.status) {
      case "found":
        tools.push(lookup.tool)
        break
      case "not-connected":
        notConnectedToolName ??= name
        break
      case "unknown":
        unknownNames.push(name)
        break
      default: {
        const unhandledLookup: never = lookup
        throw new TypeError(
          `Unhandled MCP tool lookup: ${JSON.stringify(unhandledLookup)}`
        )
      }
    }
  }
  return Object.freeze({
    tools: Object.freeze(tools),
    notConnectedToolName,
    unknownNames: Object.freeze(unknownNames)
  })
}

/**
 * Finds what a chat or chat-context request names about the tools its turn
 * does not offer.
 *
 * @param builtInTools - Every built-in tool.
 * @param body - Validated request body.
 * @returns `TOOL_CALLS_OFF` when the request switches tool calls off;
 * otherwise the switched-off names and the unavailable tools in request
 * order, none of them offered, each list empty when the request names none.
 * @throws An {@link UnknownBackendToolError} naming every tool named as
 * unable to run that belongs to no built-in tool; MCP tools are never named
 * as unable to run.
 * @remarks The reason given for an unavailable tool is the client's reading
 * of the tool list and is not checked again.
 */
export function findUnofferedTools(
  builtInTools: readonly BuiltInToolEntry[],
  body: Pick<
    ChatApiRequestBody,
    "switchedOffToolNames" | "unavailableTools" | "areToolCallsSwitchedOff"
  >
): UnofferedTools {
  if (body.areToolCallsSwitchedOff === true) return TOOL_CALLS_OFF
  const { switchedOffToolNames, unavailableTools } = body
  const selection = findBuiltInTools(
    builtInTools,
    unavailableTools?.map((tool) => tool.name)
  )
  if (selection.status === "unknown")
    throw new UnknownBackendToolError(selection.toolNames)
  return Object.freeze({
    status: "tool-calls-on",
    switchedOffToolNames:
      switchedOffToolNames ?? NO_UNOFFERED_TOOLS.switchedOffToolNames,
    unavailableTools: unavailableTools ?? NO_UNOFFERED_TOOLS.unavailableTools
  })
}

/**
 * Loads the live agent that answers the requested turn.
 *
 * @param conversation - Conversation the validated request starts or
 * continues.
 * @param dependencies - Borrowed live agent loading and conversation lookup.
 * @returns The live agent, made live when it was not, or why no agent
 * answers: a new conversation names a
 * code no agent has, a continued conversation is not stored, or its agent no
 * longer exists. Nothing is stored or sent.
 * @throws Any persistence failure of a lookup.
 * @remarks A job's agent is found like any other conversation's, so the
 * context of a job can be measured. The chat route refuses the person's
 * message to a job itself, before it asks here.
 */
export function loadRequestedAgent(
  conversation: ChatApiRequestBody["conversation"],
  dependencies: TurnAgentLookups
): RequestedAgentOutcome {
  if (conversation.kind === "new") {
    const agent = dependencies.loadChatAgent(conversation.agentCode)
    return agent === undefined
      ? { status: "agent-not-found", agentCode: conversation.agentCode }
      : { status: "found", agent }
  }

  const agentCode = dependencies.findConversationAgentCode(conversation.id)
  if (agentCode === undefined)
    return { status: "conversation-not-found", conversationId: conversation.id }
  const agent = dependencies.loadChatAgent(agentCode)
  return agent === undefined
    ? { status: "conversation-agent-missing", agentCode }
    : { status: "found", agent }
}

/**
 * Builds the problem that says why no agent answers a requested turn.
 *
 * @param outcome - Outcome without an agent: of the agent lookup, or of the
 * person's message to a job.
 * @param instance - Request path identifying this occurrence.
 * @returns The missing-agent problem for a new conversation's unknown code,
 * the missing-conversation problem for a conversation that is not stored,
 * the conversation agent missing problem for one whose agent no longer
 * exists, and the conversation-is-job problem for a job.
 */
function buildUnansweredTurnProblem(
  outcome: UnansweredTurnOutcome,
  instance: string
):
  | AgentNotFoundProblem
  | ConversationNotFoundProblem
  | ConversationAgentMissingProblem
  | ConversationIsJobProblem {
  switch (outcome.status) {
    case "agent-not-found":
      return createAgentNotFoundProblem(outcome.agentCode, instance)
    case "conversation-not-found":
      return createConversationNotFoundProblem(outcome.conversationId, instance)
    case "conversation-agent-missing":
      return createConversationAgentMissingProblem(outcome.agentCode, instance)
    case "conversation-is-job":
      return createConversationIsJobProblem(outcome.conversationId, instance)
  }
}

/**
 * Sends the problem response for a requested turn no agent answers.
 *
 * @param reply - Response owner; the response has not started.
 * @param outcome - Outcome without an agent: of the agent lookup, or of the
 * person's message to a job.
 * @param instance - Request path identifying this occurrence.
 */
export function sendUnansweredTurnProblem(
  reply: FastifyReply,
  outcome: UnansweredTurnOutcome,
  instance: string
): void {
  const problem = buildUnansweredTurnProblem(outcome, instance)
  reply.type("application/problem+json").code(problem.status).send(problem)
}
