import {
  agentCodeSchema,
  FIND_AGENTS_TOOL_NAME,
  READ_AGENT_STATE_TOOL_NAME,
  READ_MY_STATE_TOOL_NAME,
  toolDefinitionSchema,
  type ToolDefinition
} from "@lys/share"
import type {
  BuiltInToolCallArguments,
  BuiltInToolResult,
  ParsedBuiltInToolCall,
  TurnBuiltInTool
} from "../tool/builtIn/builtInTool"
import type {
  AgentRequestState,
  AgentRequestStep,
  AgentToolCallState,
  AgentToolCallStatus
} from "./agentActivity"
import {
  hasAgentPermission,
  type AgentIdentity,
  type AgentRole
} from "./agentRoles"
import { MAXIMUM_AGENT_SEARCH_MATCHES } from "./capabilities"

/** Inclusive maximum length of a trimmed agent query, in UTF-16 code units. */
const MAXIMUM_AGENT_QUERY_LENGTH = 100

/** One agent an agent search found, as the state tools show it. */
export type AgentListing = Readonly<{
  /** Code of the agent. */
  code: string
  /** Display name of the agent. */
  name: string
  /** Short description of what the agent does; never empty. */
  bio: string
  /** Role of the agent. */
  role: AgentRole
  /** Time a stored agent was deleted; null while it is not deleted. */
  deletedAt: string | null
}>

/** One request an agent is working on, with the title of its conversation. */
export type AgentRequestView = AgentRequestState &
  Readonly<{
    /**
     * Title of the request's conversation: null while it has none, and
     * undefined once the conversation was deleted.
     */
    conversationTitle: string | null | undefined
  }>

/** State of one agent: who it is and the requests it is working on. */
export type AgentStateView = Readonly<{
  /** Code of the agent. */
  code: string
  /** Display name of the agent. */
  name: string
  /** Role of the agent. */
  role: AgentRole
  /** Time a stored agent was deleted; null while it is not deleted. */
  deletedAt: string | null
  /** Requests the agent is working on, in the order they started. */
  requests: readonly AgentRequestView[]
}>

/** Outcome of one agent search. */
export type AgentSearchOutcome =
  | Readonly<{
      /** The agent that asked may not find agents. */
      status: "forbidden"
    }>
  | Readonly<{
      /** The search ran. */
      status: "found"
      /** First matches, in search order. */
      matches: readonly AgentListing[]
      /** Number of all matches, the ones not listed included. */
      matchCount: number
    }>

/** Outcome of reading one agent's state. */
export type AgentStateOutcome =
  | Readonly<{
      /** The agent that asked may not read that agent's state. */
      status: "forbidden"
    }>
  | Readonly<{
      /** No built-in or stored agent, deleted ones included, has the code. */
      status: "missing"
    }>
  | Readonly<{
      /** The agent exists. */
      status: "found"
      /** Its state at the moment of the read. */
      state: AgentStateView
    }>

/**
 * An agent state reader can tell an agent which agents exist and what an
 * agent is doing, as far as the asking agent's role allows.
 *
 * @remarks Consumed by the state tools of each turn, which an agent offers
 * its model. The provider owns the live agents and checks the permission of
 * the asking agent before it reads anything; it is ready when created, owns
 * no resource of the caller, and keeps nothing a read returns. Concurrency
 * model: synchronous on the backend's event loop, so each read sees one
 * consistent moment. Every provider answers the same identity and code with
 * the same outcome for the same stored agents and live requests.
 */
export interface AgentStateReader {
  /**
   * Finds the agents whose code, name, or bio contains a text.
   *
   * @param reader - The agent that asks.
   * @param query - Trimmed text of 1 to {@link MAXIMUM_AGENT_QUERY_LENGTH}
   * UTF-16 code units.
   * @returns `forbidden` when the reader's role does not grant
   * `find-agents`, without searching; otherwise `found` with the frozen
   * first matches, deleted agents included, and the number of all matches.
   * Bounded synchronous work with no side effect.
   * @throws Only on a defect, such as a closed store.
   */
  findAgents(reader: AgentIdentity, query: string): AgentSearchOutcome

  /**
   * Reads the state of one agent.
   *
   * @param reader - The agent that asks.
   * @param code - Code of the agent to read; the reader's own code reads its
   * own state.
   * @returns `forbidden` when the reader's role does not grant
   * `read-own-state` for its own code or `read-any-state` for another code,
   * without reading anything; `missing` when no agent has the code; else
   * `found` with the frozen state. A read never starts or keeps an agent.
   * Bounded synchronous work with no side effect.
   * @throws Only on a defect, such as a closed store.
   */
  readAgentState(reader: AgentIdentity, code: string): AgentStateOutcome
}

/** What the state tools of one turn need. */
export type AgentStateToolContext = Readonly<{
  /** The agent whose turn offers the tools. */
  self: AgentIdentity
  /** UUIDv7 of the reply the turn writes. */
  requestId: string
  /** Reads agents and their state; lent for the turn. */
  reader: AgentStateReader
}>

/** Copy shown for a query that is blank or too long. */
const INVALID_QUERY_MESSAGE = `The query must be 1 to ${MAXIMUM_AGENT_QUERY_LENGTH} characters long after trimming.`

/** Copy shown for a value that cannot be an agent code. */
const INVALID_CODE_MESSAGE = `The code must be an agent code: lowercase letters and digits in groups joined by single hyphens, such as "caliginia". Use ${FIND_AGENTS_TOOL_NAME} to look an agent up by name.`

/** Copy shown when the asking agent may not see other agents. */
const FORBIDDEN_MESSAGE = "Only leaders can see other agents."

/** What the state tools offer an agent of each role. */
const ROLE_SCOPE_TEXT: Readonly<Record<AgentRole, string>> = Object.freeze({
  leader:
    "As a leader you can find other agents with find_agents and read their state with read_agent_state.",
  member: "As a member you can see only your own state."
})

/** Words for each status of a tool call. */
const TOOL_CALL_STATUS_TEXT: Readonly<Record<AgentToolCallStatus, string>> =
  Object.freeze({
    "awaiting-approval": "waiting for the person's approval",
    running: "running",
    "running-in-app": "running in the app",
    succeeded: "done",
    failed: "failed",
    rejected: "rejected by the person",
    interrupted: "interrupted"
  })

/** Milliseconds in one minute. */
const MILLISECONDS_PER_MINUTE = 60_000

/** Matches one run of whitespace, line breaks included. */
const WHITESPACE_RUN_PATTERN = /\s+/g

/** Sources a state tool's result shows: none. */
const NO_SOURCES = Object.freeze([])

/**
 * Builds the definition of the tool that reads the calling agent's state.
 *
 * @param role - Role of the agent offered it.
 * @returns The validated, frozen definition; a member's says it sees only
 * its own state.
 */
function buildReadMyStateDefinition(role: AgentRole): ToolDefinition {
  const scope = hasAgentPermission(role, "read-any-state")
    ? "Use find_agents and read_agent_state to see other agents."
    : "You can see only your own state."
  return toolDefinitionSchema.parse({
    name: READ_MY_STATE_TOOL_NAME,
    description: `Read your own state: who you are, your role, and each request you are working on right now, the reply you are writing included, with its conversation, model, start time, and step. ${scope}`,
    group: "agents",
    access: "reads",
    runner: "backend",
    arguments: []
  })
}

/** Definition of the tool that finds agents. */
const FIND_AGENTS_DEFINITION = toolDefinitionSchema.parse({
  name: FIND_AGENTS_TOOL_NAME,
  description: `Find agents whose code, name, or short description contains a text, ignoring case. Lists up to ${MAXIMUM_AGENT_SEARCH_MATCHES} agents with their code, role, and description, deleted agents included, and says how many more match. Use an agent's code with ${READ_AGENT_STATE_TOOL_NAME}.`,
  group: "agents",
  access: "reads",
  runner: "backend",
  arguments: [
    {
      type: "string",
      name: "query",
      description: `Text to look for, 1 to ${MAXIMUM_AGENT_QUERY_LENGTH} characters.`
    }
  ]
})

/** Definition of the tool that reads another agent's state. */
const READ_AGENT_STATE_DEFINITION = toolDefinitionSchema.parse({
  name: READ_AGENT_STATE_TOOL_NAME,
  description: `Read the state of an agent by its code: who it is, its role, and each request it is working on right now, with its conversation, model, start time, and step. Find a code with ${FIND_AGENTS_TOOL_NAME}.`,
  group: "agents",
  access: "reads",
  runner: "backend",
  arguments: [
    {
      type: "string",
      name: "code",
      description: 'Code of the agent, such as "caliginia".'
    }
  ]
})

/**
 * Formats text a person or a model wrote onto one line.
 *
 * @param text - Name, description, or title.
 * @returns The text with each whitespace run, line breaks included, as one
 * space.
 */
function formatOneLine(text: string): string {
  return text.replaceAll(WHITESPACE_RUN_PATTERN, " ")
}

/**
 * Builds a parsed call whose run reads the clock once.
 *
 * @param runAt - Runs the call at the time the run started.
 * @returns The parsed call: each run rejects with the abort reason when the
 * signal already aborted, and otherwise gives `runAt`'s result.
 */
function buildParsedCall(
  runAt: (now: Date) => BuiltInToolResult
): ParsedBuiltInToolCall {
  return Object.freeze({
    status: "parsed",
    runToolCall: async ({ abortSignal }) => {
      abortSignal.throwIfAborted()
      return runAt(new Date())
    }
  })
}

/**
 * Builds a result the model reads as a success.
 *
 * @param lines - Lines of the output.
 * @returns The result, showing no sources.
 */
function buildSucceededResult(lines: readonly string[]): BuiltInToolResult {
  return Object.freeze({
    status: "succeeded",
    content: lines.join("\n"),
    sources: NO_SOURCES
  })
}

/**
 * Formats how long ago a request started.
 *
 * @param startedAt - Start time, in the stored format.
 * @param now - Time of the run.
 * @returns Whole minutes, or that it was less than a minute ago.
 */
function formatElapsedTime(startedAt: string, now: Date): string {
  const minutes = Math.floor(
    (now.getTime() - Date.parse(startedAt)) / MILLISECONDS_PER_MINUTE
  )
  if (minutes < 1) return "less than a minute ago"
  return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`
}

/**
 * Formats one tool call of a request's round.
 *
 * @param call - The call's state.
 * @returns Its tool name and the words for its status.
 */
function formatToolCall(call: AgentToolCallState): string {
  return `${call.toolName} ${TOOL_CALL_STATUS_TEXT[call.status]}`
}

/**
 * Formats the step a request is at.
 *
 * @param step - The request's step.
 * @returns Words for it; a later round's preparation reads the tool results.
 */
function formatRequestStep(step: AgentRequestStep): string {
  switch (step.kind) {
    case "preparing":
      return step.round === 0
        ? "getting ready to answer"
        : "reading tool results"
    case "thinking":
      return "thinking"
    case "writing":
      return "writing the reply"
    case "using-tools":
      return `using tools: ${step.toolCalls.map(formatToolCall).join(", ")}`
  }
}

/**
 * Formats where a request is.
 *
 * @param request - The request.
 * @param requestId - Reply id of the turn that calls the tool.
 * @returns The calling reply itself, or the request's conversation.
 */
function formatRequestPlace(
  request: AgentRequestView,
  requestId: string
): string {
  if (request.requestId === requestId) return "This reply, in this conversation"
  if (request.conversationTitle === undefined)
    return "In a conversation that was deleted"
  if (request.conversationTitle === null) return "In an untitled conversation"
  return `In "${formatOneLine(request.conversationTitle)}"`
}

/**
 * Formats one request an agent is working on.
 *
 * @param request - The request.
 * @param requestId - Reply id of the turn that calls the tool.
 * @param now - Time of the run.
 * @returns Where it is, when it started, its model, and its step.
 */
function formatRequest(
  request: AgentRequestView,
  requestId: string,
  now: Date
): string {
  const place = formatRequestPlace(request, requestId)
  const elapsed = formatElapsedTime(request.startedAt, now)
  return `${place}: started ${request.startedAt} (${elapsed}) with ${request.model}; ${formatRequestStep(request.step)}.`
}

/**
 * Formats the requests an agent is working on.
 *
 * @param requests - The agent's requests, in start order.
 * @param requestId - Reply id of the turn that calls the tool.
 * @param now - Time of the run.
 * @returns The time of the run, then the numbered requests, ending with a
 * note when the calling reply is the only one.
 */
function formatRequests(
  requests: readonly AgentRequestView[],
  requestId: string,
  now: Date
): readonly string[] {
  const clock = `Now: ${now.toISOString()}.`
  if (requests.length === 0) return [clock, "No requests in progress."]
  const count =
    requests.length === 1
      ? "Working on 1 request:"
      : `Working on ${requests.length} requests:`
  const lines = requests.map(
    (request, index) =>
      `${index + 1}. ${formatRequest(request, requestId, now)}`
  )
  const isOnlyCallingReply =
    requests.length === 1 && requests[0]?.requestId === requestId
  return isOnlyCallingReply
    ? [clock, count, ...lines, "Nothing else is in progress."]
    : [clock, count, ...lines]
}

/**
 * Formats who the calling agent is.
 *
 * @param state - The calling agent's state.
 * @returns Its name, code, role, deletion, and what its role lets it see.
 */
function formatOwnHeader(state: AgentStateView): string {
  const deletion =
    state.deletedAt === null ? "" : ` You were deleted on ${state.deletedAt}.`
  return `You are ${formatOneLine(state.name)} (code ${state.code}), a ${state.role}.${deletion} ${ROLE_SCOPE_TEXT[state.role]}`
}

/**
 * Formats who another agent is.
 *
 * @param state - The agent's state.
 * @returns Its name, code, role, and deletion.
 */
function formatOtherHeader(state: AgentStateView): string {
  const deletion =
    state.deletedAt === null ? "" : ` It was deleted on ${state.deletedAt}.`
  return `${formatOneLine(state.name)} (code ${state.code}) is a ${state.role}.${deletion}`
}

/**
 * Builds the result of a state read that found nothing to show.
 *
 * @param outcome - Why: the reader may not read it, or no agent has the
 * code.
 * @param code - Code the call named.
 * @returns A failed result the model can act on.
 */
function buildRefusedStateResult(
  outcome: Exclude<AgentStateOutcome, { status: "found" }>,
  code: string
): BuiltInToolResult {
  return Object.freeze({
    status: "failed",
    content:
      outcome.status === "forbidden"
        ? FORBIDDEN_MESSAGE
        : `No agent has the code "${code}". Use ${FIND_AGENTS_TOOL_NAME} to look an agent up by name.`
  })
}

/**
 * Runs one call of `read_my_state`.
 *
 * @param context - The turn's agent, reply, and reader.
 * @param now - Time of the run.
 * @returns The calling agent's state, or why it cannot be read.
 */
function runReadMyState(
  context: AgentStateToolContext,
  now: Date
): BuiltInToolResult {
  const outcome = context.reader.readAgentState(context.self, context.self.code)
  if (outcome.status !== "found")
    return buildRefusedStateResult(outcome, context.self.code)
  return buildSucceededResult([
    formatOwnHeader(outcome.state),
    ...formatRequests(outcome.state.requests, context.requestId, now)
  ])
}

/**
 * Runs one call of `read_agent_state`.
 *
 * @param code - Code of the agent to read.
 * @param context - The turn's agent, reply, and reader.
 * @param now - Time of the run.
 * @returns The agent's state, or why it cannot be read.
 */
function runReadAgentState(
  code: string,
  context: AgentStateToolContext,
  now: Date
): BuiltInToolResult {
  const outcome = context.reader.readAgentState(context.self, code)
  if (outcome.status !== "found") return buildRefusedStateResult(outcome, code)
  return buildSucceededResult([
    formatOtherHeader(outcome.state),
    ...formatRequests(outcome.state.requests, context.requestId, now)
  ])
}

/**
 * Formats one agent a search found.
 *
 * @param listing - The agent.
 * @returns A list line with its name, code, role, deletion, and bio.
 */
function formatListing(listing: AgentListing): string {
  const deletion =
    listing.deletedAt === null ? "" : `, deleted on ${listing.deletedAt}`
  return `- ${formatOneLine(listing.name)} (code ${listing.code}), ${listing.role}${deletion}: ${formatOneLine(listing.bio)}`
}

/**
 * Formats the agents a search found.
 *
 * @param query - The trimmed query.
 * @param found - The search's matches and their number.
 * @returns How many agents match, one line per listed match, and how many
 * more were not listed.
 */
function formatSearch(
  query: string,
  found: Extract<AgentSearchOutcome, { status: "found" }>
): readonly string[] {
  if (found.matchCount === 0) return [`No agent matches "${query}".`]
  const count =
    found.matchCount === 1
      ? `1 agent matches "${query}":`
      : `${found.matchCount} agents match "${query}":`
  const lines = [count, ...found.matches.map(formatListing)]
  const unlisted = found.matchCount - found.matches.length
  return unlisted > 0
    ? [
        ...lines,
        `${unlisted} more not shown; use a longer query to narrow them.`
      ]
    : lines
}

/**
 * Runs one call of `find_agents`.
 *
 * @param query - The trimmed, bounded query.
 * @param context - The turn's agent and reader.
 * @returns The matches, or why the agent may not search.
 */
function runFindAgents(
  query: string,
  context: AgentStateToolContext
): BuiltInToolResult {
  const outcome = context.reader.findAgents(context.self, query)
  if (outcome.status === "forbidden")
    return Object.freeze({ status: "failed", content: FORBIDDEN_MESSAGE })
  return buildSucceededResult(formatSearch(query, outcome))
}

/**
 * Parses one call of `read_my_state`, which takes no argument.
 *
 * @param context - The turn's agent, reply, and reader.
 * @returns The read of the calling agent's state.
 */
function parseReadMyStateCall(
  context: AgentStateToolContext
): ParsedBuiltInToolCall {
  return buildParsedCall((now) => runReadMyState(context, now))
}

/**
 * Parses one call of `find_agents`.
 *
 * @param context - The turn's agent and reader.
 * @param callArguments - The call's arguments.
 * @returns The run of the trimmed query, or `invalid` when it is not text,
 * is blank, or is longer than {@link MAXIMUM_AGENT_QUERY_LENGTH}.
 */
function parseFindAgentsCall(
  context: AgentStateToolContext,
  callArguments: BuiltInToolCallArguments
): ParsedBuiltInToolCall {
  const value = callArguments["query"]
  const query = typeof value === "string" ? value.trim() : undefined
  if (
    query === undefined ||
    query.length === 0 ||
    query.length > MAXIMUM_AGENT_QUERY_LENGTH
  )
    return Object.freeze({ status: "invalid", message: INVALID_QUERY_MESSAGE })
  return buildParsedCall(() => runFindAgents(query, context))
}

/**
 * Parses one call of `read_agent_state`.
 *
 * @param context - The turn's agent, reply, and reader.
 * @param callArguments - The call's arguments.
 * @returns The read of the code, or `invalid` when the value cannot be an
 * agent code.
 */
function parseReadAgentStateCall(
  context: AgentStateToolContext,
  callArguments: BuiltInToolCallArguments
): ParsedBuiltInToolCall {
  const code = agentCodeSchema.safeParse(callArguments["code"])
  if (!code.success)
    return Object.freeze({ status: "invalid", message: INVALID_CODE_MESSAGE })
  return buildParsedCall((now) => runReadAgentState(code.data, context, now))
}

/** One state tool: its definition and the parser of its calls. */
type AgentStateToolEntry = Readonly<{
  /** Definition the model is offered. */
  definition: ToolDefinition
  /**
   * Parses one call of the tool.
   *
   * @param context - The turn's agent, reply, and reader.
   * @param callArguments - The call's arguments.
   * @returns The parsed call, or `invalid` with what the model reads.
   */
  parseCall: (
    context: AgentStateToolContext,
    callArguments: BuiltInToolCallArguments
  ) => ParsedBuiltInToolCall
}>

/**
 * Builds the state tools one role is offered.
 *
 * @param role - Role of the agent.
 * @returns The frozen tools its permissions grant, in offer order, each
 * with its own parser.
 */
function buildRoleTools(role: AgentRole): readonly AgentStateToolEntry[] {
  const tools: AgentStateToolEntry[] = []
  if (hasAgentPermission(role, "read-own-state"))
    tools.push(
      Object.freeze({
        definition: buildReadMyStateDefinition(role),
        parseCall: parseReadMyStateCall
      })
    )
  if (hasAgentPermission(role, "find-agents"))
    tools.push(
      Object.freeze({
        definition: FIND_AGENTS_DEFINITION,
        parseCall: parseFindAgentsCall
      })
    )
  if (hasAgentPermission(role, "read-any-state"))
    tools.push(
      Object.freeze({
        definition: READ_AGENT_STATE_DEFINITION,
        parseCall: parseReadAgentStateCall
      })
    )
  return Object.freeze(tools)
}

/** State tools of each role, built once. */
const ROLE_TOOLS: Readonly<Record<AgentRole, readonly AgentStateToolEntry[]>> =
  Object.freeze({
    leader: buildRoleTools("leader"),
    member: buildRoleTools("member")
  })

/** State tool definitions of each role, built once from its tools. */
const ROLE_DEFINITIONS: Readonly<Record<AgentRole, readonly ToolDefinition[]>> =
  Object.freeze({
    leader: Object.freeze(ROLE_TOOLS.leader.map((tool) => tool.definition)),
    member: Object.freeze(ROLE_TOOLS.member.map((tool) => tool.definition))
  })

/**
 * Builds the definitions of the state tools an agent of a role is offered.
 *
 * @param role - Role of the agent.
 * @returns The frozen definitions, the same on every call: `read_my_state`
 * for both roles, then `find_agents` and `read_agent_state` for a leader.
 * Each is in the `agents` group, reads this machine, and runs in the
 * backend.
 */
export function buildAgentStateDefinitions(
  role: AgentRole
): readonly ToolDefinition[] {
  return ROLE_DEFINITIONS[role]
}

/**
 * Builds the state tools one turn offers its agent.
 *
 * @param context - The turn's agent, reply, and reader.
 * @returns One frozen tool per definition of
 * {@link buildAgentStateDefinitions} for the agent's role, in that order;
 * each call runs without the person's approval, reads what the agent's role
 * allows when it runs, and reads the clock once.
 */
export function buildAgentStateTools(
  context: AgentStateToolContext
): readonly TurnBuiltInTool[] {
  return Object.freeze(
    ROLE_TOOLS[context.self.role].map(({ definition, parseCall }) =>
      Object.freeze({
        definition,
        tool: {
          parseToolCall: (callArguments: BuiltInToolCallArguments) =>
            parseCall(context, callArguments)
        },
        runsWithoutApproval: true
      })
    )
  )
}
