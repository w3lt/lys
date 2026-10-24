import type { ReplyPart, ToolCallReplyPartStatus } from "@lys/share"

/**
 * State of one tool call as an agent tells it: the stored status, except
 * that a running call of a client tool is `running-in-app`, because the
 * person's app runs it.
 */
export type AgentToolCallStatus = ToolCallReplyPartStatus | "running-in-app"

/** One tool call of the round a request is in. */
export type AgentToolCallState = Readonly<{
  /** UUIDv7 of the call, its tool-call part's identity. */
  toolCallId: string
  /** Name the model called; it may name a tool that was not offered. */
  toolName: string
  /** Where the call stands. */
  status: AgentToolCallStatus
}>

/**
 * Step one request is at, in the model round it is in.
 *
 * @remarks `preparing`: the round started and no part is stored yet, while
 * the context is measured and the model reads it; `thinking`: the round's
 * last stored part is reasoning; `writing`: it is text; `using-tools`: the
 * round's last stored part is a tool call, with every call of the round in
 * the order the model made them.
 */
export type AgentRequestStep =
  | Readonly<{ kind: "preparing" | "thinking" | "writing"; round: number }>
  | Readonly<{
      kind: "using-tools"
      round: number
      toolCalls: readonly AgentToolCallState[]
    }>

/** One request an agent is working on. */
export type AgentRequestState = Readonly<{
  /** UUIDv7 of the reply the request writes. */
  requestId: string
  /** UUIDv7 of the conversation the reply belongs to. */
  conversationId: string
  /** Model that writes the reply. */
  model: string
  /** Time the request started, in the stored format. */
  startedAt: string
  /** Step the request is at. */
  step: AgentRequestStep
}>

/** What an agent knows about a request when it starts working on it. */
export type AgentRequestStart = Readonly<{
  /** UUIDv7 of the reply the request writes. */
  requestId: string
  /** UUIDv7 of the conversation the reply belongs to. */
  conversationId: string
  /** Model that writes the reply. */
  model: string
  /** Time the request started, in the stored format. */
  startedAt: string
  /** Names of the client tools the turn offers, which the app runs. */
  clientToolNames: ReadonlySet<string>
}>

/** One followed request: its start, its step, and its round's calls. */
type FollowedRequest = {
  /** The request as it started. */
  readonly start: AgentRequestStart
  /** Frozen step the request is at, replaced on each change. */
  step: AgentRequestStep
  /** Frozen calls of the current round in the order they were made. */
  toolCalls: readonly AgentToolCallState[]
}

/**
 * Builds the frozen state of one tool call from its stored part.
 * @param part - Stored tool call.
 * @param clientToolNames - Client tools the turn offers.
 * @returns The call's state; `running` becomes `running-in-app` for a client
 * tool.
 */
function buildToolCallState(
  part: Extract<ReplyPart, { kind: "tool-call" }>,
  clientToolNames: ReadonlySet<string>
): AgentToolCallState {
  return Object.freeze({
    toolCallId: part.id,
    toolName: part.toolName,
    status:
      part.status === "running" && clientToolNames.has(part.toolName)
        ? "running-in-app"
        : part.status
  })
}

/**
 * Adds a call to the round's calls, or replaces the state of a call already
 * there.
 * @param toolCalls - Calls of the round so far.
 * @param call - The call's new state.
 * @returns The frozen calls, the call in its first position.
 */
function buildRoundToolCalls(
  toolCalls: readonly AgentToolCallState[],
  call: AgentToolCallState
): readonly AgentToolCallState[] {
  const isKnown = toolCalls.some(
    (known) => known.toolCallId === call.toolCallId
  )
  return Object.freeze(
    isKnown
      ? toolCalls.map((known) =>
          known.toolCallId === call.toolCallId ? call : known
        )
      : [...toolCalls, call]
  )
}

/** Calls of a round before the model made any. */
const NO_TOOL_CALLS: readonly AgentToolCallState[] = Object.freeze([])

/**
 * Follows the requests one agent is working on and the step each is at.
 *
 * @remarks Every change is synchronous and comes from the agent's reply
 * work: a request starts, a round starts, a part is stored, or the request
 * ends. A change for a request it does not follow changes nothing. A request
 * id is started once. Owns no resource. Concurrency model: single-owner,
 * synchronous on the backend's event loop.
 */
export default class AgentActivity {
  /** Followed requests by reply id, in the order they started. */
  readonly #requests = new Map<string, FollowedRequest>()

  /**
   * Follows a request, preparing its first round.
   * @param start - The request's identity, model, start time, and client
   * tools.
   */
  public addRequest(start: AgentRequestStart): void {
    this.#requests.set(start.requestId, {
      start,
      step: Object.freeze({ kind: "preparing", round: 0 }),
      toolCalls: NO_TOOL_CALLS
    })
  }

  /**
   * Shows a request preparing a new model round, without the previous
   * round's calls.
   * @param requestId - Reply id of the request.
   * @param round - Zero-based round that starts.
   */
  public updateRequestRound(requestId: string, round: number): void {
    const request = this.#requests.get(requestId)
    if (request === undefined) return
    request.step = Object.freeze({ kind: "preparing", round })
    request.toolCalls = NO_TOOL_CALLS
  }

  /**
   * Shows the step a stored part puts a request at.
   * @param requestId - Reply id of the request.
   * @param part - Part just stored, or a tool call just changed: reasoning
   * means thinking, text writing, and a tool call using tools, with the
   * call added to the round's calls or its state replaced.
   */
  public updateRequestStep(requestId: string, part: ReplyPart): void {
    const request = this.#requests.get(requestId)
    if (request === undefined) return
    if (part.kind !== "tool-call") {
      request.step = Object.freeze({
        kind: part.kind === "reasoning" ? "thinking" : "writing",
        round: part.round
      })
      return
    }
    request.toolCalls = buildRoundToolCalls(
      request.toolCalls,
      buildToolCallState(part, request.start.clientToolNames)
    )
    request.step = Object.freeze({
      kind: "using-tools",
      round: part.round,
      toolCalls: request.toolCalls
    })
  }

  /**
   * Stops following a request, whatever its outcome.
   * @param requestId - Reply id of the request.
   */
  public removeRequest(requestId: string): void {
    this.#requests.delete(requestId)
  }

  /**
   * Lists the requests the agent is working on.
   * @returns A frozen list in start order; later changes leave it as it
   * was.
   */
  public listRequests(): readonly AgentRequestState[] {
    return Object.freeze(
      [...this.#requests.values()].map((request) =>
        Object.freeze({
          requestId: request.start.requestId,
          conversationId: request.start.conversationId,
          model: request.start.model,
          startedAt: request.start.startedAt,
          step: request.step
        })
      )
    )
  }
}
