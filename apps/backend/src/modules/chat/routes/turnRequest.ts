import type {
  AgentNotFoundProblem,
  ChatApiRequestBody,
  ChatToolOffer,
  ConversationAgentMissingProblem,
  ConversationNotFoundProblem
} from "@lys/protocol"
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
import { createConversationNotFoundProblem } from "../../conversation/routes/notFound"
import type { BuiltInToolEntry } from "../../tool/builtIn/builtInTool"
import { findBuiltInTools } from "../../tool/builtIn/builtInTools"

/** Lookups that find the agent answering a requested turn. */
export type TurnAgentLookups = Readonly<{
  /**
   * Agent lookup of the agent service; undefined means no built-in or stored
   * agent has the code.
   */
  findChatAgent: (code: string) => Agent | undefined
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

/** Outcome in which no agent answers the requested turn. */
export type UnansweredTurnOutcome = Exclude<
  RequestedAgentOutcome,
  Readonly<{ status: "found" }>
>

/**
 * Finds the backend tools a request offers.
 *
 * @param builtInTools - Every tool the backend runs.
 * @param tools - Validated tool offer of the request; absence offers none.
 * @returns The offered backend tools in offer order; empty when the request
 * offers none.
 * @throws An {@link UnknownBackendToolError} naming every offered name that
 * belongs to no backend tool.
 */
export function findRequestedBuiltInTools(
  builtInTools: readonly BuiltInToolEntry[],
  tools: ChatToolOffer | undefined
): readonly BuiltInToolEntry[] {
  const selection = findBuiltInTools(builtInTools, tools?.backendToolNames)
  switch (selection.status) {
    case "found":
      return selection.entries
    case "unknown":
      throw new UnknownBackendToolError(selection.toolNames)
  }
}

/**
 * Finds what a chat or chat-context request names about the tools its turn
 * does not offer.
 *
 * @param builtInTools - Every tool the backend runs.
 * @param body - Validated request body.
 * @returns `TOOL_CALLS_OFF` when the request switches tool calls off;
 * otherwise the switched-off names and the unavailable tools in request
 * order, none of them offered, each list empty when the request names none.
 * @throws An {@link UnknownBackendToolError} naming every tool named as
 * unable to run that belongs to no backend tool.
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
 * Finds the agent that answers the requested turn.
 *
 * @param conversation - Conversation the validated request starts or
 * continues.
 * @param dependencies - Borrowed agent and conversation lookups.
 * @returns The agent, or why no agent answers: a new conversation names a
 * code no agent has, a continued conversation is not stored, or its agent no
 * longer exists. Nothing is stored or sent.
 * @throws Any persistence failure of a lookup.
 */
export function findRequestedAgent(
  conversation: ChatApiRequestBody["conversation"],
  dependencies: TurnAgentLookups
): RequestedAgentOutcome {
  if (conversation.kind === "new") {
    const agent = dependencies.findChatAgent(conversation.agentCode)
    return agent === undefined
      ? { status: "agent-not-found", agentCode: conversation.agentCode }
      : { status: "found", agent }
  }

  const agentCode = dependencies.findConversationAgentCode(conversation.id)
  if (agentCode === undefined)
    return { status: "conversation-not-found", conversationId: conversation.id }
  const agent = dependencies.findChatAgent(agentCode)
  return agent === undefined
    ? { status: "conversation-agent-missing", agentCode }
    : { status: "found", agent }
}

/**
 * Builds the problem that says why no agent answers a requested turn.
 *
 * @param outcome - Lookup outcome without an agent.
 * @param instance - Request path identifying this occurrence.
 * @returns The missing-agent problem for a new conversation's unknown code,
 * the missing-conversation problem for a conversation that is not stored, and
 * the conversation agent missing problem for one whose agent no longer exists.
 */
function buildUnansweredTurnProblem(
  outcome: UnansweredTurnOutcome,
  instance: string
):
  | AgentNotFoundProblem
  | ConversationNotFoundProblem
  | ConversationAgentMissingProblem {
  switch (outcome.status) {
    case "agent-not-found":
      return createAgentNotFoundProblem(outcome.agentCode, instance)
    case "conversation-not-found":
      return createConversationNotFoundProblem(outcome.conversationId, instance)
    case "conversation-agent-missing":
      return createConversationAgentMissingProblem(outcome.agentCode, instance)
  }
}

/**
 * Sends the problem response for a requested turn no agent answers.
 *
 * @param reply - Response owner; the response has not started.
 * @param outcome - Lookup outcome without an agent.
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
