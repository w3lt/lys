import type { ReplyPart, ToolCallReplyPartStatus } from "@lys/share"
import { waitForSettlementOrAbort } from "../../utils/abort"

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
 * Step one request is at: waiting for a request slot, or in the model round
 * it is in.
 *
 * @remarks `waiting`: every request slot of the agent is held, and the
 * request waits in line for one, before its first round; `preparing`: the
 * round started and no part is stored yet, while the context is measured and
 * the model reads it; `thinking`: the round's last stored part is reasoning;
 * `writing`: it is text; `using-tools`: the round's last stored part is a
 * tool call, with every call of the round in the order the model made them.
 */
export type AgentRequestStep =
  | Readonly<{ kind: "waiting" }>
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

/** How many requests one agent works on at once, and how many may wait. */
export type AgentRequestLimits = Readonly<{
  /**
   * Request slots: requests the agent works on at once; a positive integer.
   */
  slotCount: number
  /**
   * Inclusive maximum number of requests that wait for a free slot at a
   * time; a non-negative integer, 0 when no request may wait.
   */
  waitingLimit: number
}>

/** What an agent's activity did with a request offered to it. */
export type AgentRequestOffer =
  | Readonly<{
      /** The request holds a request slot and is followed. */
      status: "started"
    }>
  | Readonly<{
      /**
       * Every slot was held and the line was full when the request was
       * offered, so it is not followed.
       */
      status: "refused"
      /** The limits that were reached. */
      limits: AgentRequestLimits
    }>

/**
 * Failure that ends a reply because every request slot of its agent was held
 * and the line of waiting requests was full when the reply started.
 *
 * @remarks Passive failure value constructed once per refused reply; nothing
 * of the reply was sent to the model. It preserves the native `Error`
 * contract, and its limits never change.
 */
export class AgentRequestLimitError extends Error {
  /** The limits the agent had reached. */
  readonly #limits: AgentRequestLimits

  /**
   * Creates the failure for one refused reply.
   *
   * @param limits - The agent's request limits, all of them reached.
   */
  public constructor(limits: AgentRequestLimits) {
    super(
      `The agent's request slots and line were full: slots held ${limits.slotCount} of ${limits.slotCount}, requests waiting ${limits.waitingLimit} of ${limits.waitingLimit}`
    )
    this.#limits = limits
  }

  /**
   * Limits of the agent that refused the reply.
   *
   * @returns Its slot count and waiting limit, both reached.
   */
  public get limits(): AgentRequestLimits {
    return this.#limits
  }
}

/**
 * One followed request: its start, its step, its round's calls, and its
 * request slot.
 */
type FollowedRequest = {
  /** The request as it started. */
  readonly start: AgentRequestStart
  /** Frozen step the request is at, replaced on each change. */
  step: AgentRequestStep
  /** Frozen calls of the current round in the order they were made. */
  toolCalls: readonly AgentToolCallState[]
  /**
   * The request's slot: resolves once the request holds a request slot, at
   * once for a request that found one free; rejects when the request is
   * removed while it still waits.
   */
  readonly slot: PromiseWithResolvers<void>
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

/** Step of a request that waits for a free request slot. */
const WAITING_STEP: AgentRequestStep = Object.freeze({ kind: "waiting" })

/** Step of a request that holds a slot before its first round starts. */
const FIRST_ROUND_STEP: AgentRequestStep = Object.freeze({
  kind: "preparing",
  round: 0
})

/** Outcome of an offered request that holds a request slot. */
const STARTED_OFFER: AgentRequestOffer = Object.freeze({ status: "started" })

/** Failure of the offer of a request removed while it waited. */
const REMOVED_WHILE_WAITING_MESSAGE =
  "The request was removed while it waited for a request slot"

/**
 * Follows the requests one agent is working on and the step each is at, and
 * keeps the agent's request slots: how many of its requests run at once, and
 * which wait in line for a slot.
 *
 * @remarks Invariants: at most `slotCount` followed requests hold a slot; a
 * request waits only while every slot is held; at most `waitingLimit`
 * requests wait; and waiting requests get slots in the order they were
 * offered. A request that holds a slot keeps it until it is removed, whatever
 * it is doing. Every change is synchronous and comes from the agent's reply
 * work: a request is offered, a round starts, a part is stored, or the
 * request ends. A round or part of a request it does not follow, or that
 * still waits for a slot, changes nothing, and so does the end of a request
 * it does not follow. Owns no resource. Concurrency model:
 * single-owner, synchronous on the backend's event loop; only an offer's
 * wait for a slot spans turns of the loop.
 */
export default class AgentActivity {
  /** How many requests hold slots at once, and how many may wait. */
  readonly #limits: AgentRequestLimits

  /** Followed requests by reply id, in the order they were offered. */
  readonly #requests = new Map<string, FollowedRequest>()

  /**
   * Creates an activity that follows no request, with every slot free.
   * @param limits - Slot count and waiting limit of the agent, fixed for the
   * activity's lifetime.
   */
  public constructor(limits: AgentRequestLimits) {
    this.#limits = limits
  }

  /**
   * Offers a request to the agent: follows it with a free request slot, or
   * waiting in line for one, or refuses it.
   * @param start - The request's identity, model, start time, and client
   * tools; a reply id not followed yet.
   * @param abortSignal - Cancellation of the wait for a slot only; once the
   * request holds a slot, the signal is no longer observed here.
   * @returns A promise resolving to `started` once the request holds a
   * slot, preparing its first round: at once when a slot was free, else when
   * an earlier request is removed and hands it the slot; or to `refused`,
   * with the limits, when every slot was held and the line was full, without
   * following the request.
   * @throws The signal's abort reason when it aborts, or had aborted, before
   * a waiting request gets a slot; the request stays followed, waiting,
   * until it is removed. An `Error` when the request is removed while it
   * still waits, or when its reply id is already followed; that offer
   * follows nothing, so removing its start leaves the followed request as
   * it is.
   * @remarks The offer is decided when the call is made, before it returns
   * its promise, so offers are taken in call order and none can take a slot
   * another offer was given.
   */
  public async offerRequest(
    start: AgentRequestStart,
    abortSignal: AbortSignal
  ): Promise<AgentRequestOffer> {
    if (this.#requests.has(start.requestId))
      throw new Error("The request is already followed")
    const request = this.#addOfferedRequest(start)
    if (request === undefined)
      return Object.freeze({ status: "refused", limits: this.#limits })
    await waitForSettlementOrAbort(request.slot.promise, abortSignal)
    return STARTED_OFFER
  }

  /**
   * Shows a request preparing a new model round, without the previous
   * round's calls.
   * @param requestId - Reply id of a request that holds a slot.
   * @param round - Zero-based round that starts.
   */
  public updateRequestRound(requestId: string, round: number): void {
    const request = this.#findSlotHolder(requestId)
    if (request === undefined) return
    request.step = Object.freeze({ kind: "preparing", round })
    request.toolCalls = NO_TOOL_CALLS
  }

  /**
   * Shows the step a stored part puts a request at.
   * @param requestId - Reply id of a request that holds a slot.
   * @param part - Part just stored, or a tool call just changed: reasoning
   * means thinking, text writing, and a tool call using tools, with the
   * call added to the round's calls or its state replaced.
   */
  public updateRequestStep(requestId: string, part: ReplyPart): void {
    const request = this.#findSlotHolder(requestId)
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
   * Stops following a request, whatever its outcome, and frees its slot or
   * its place in line.
   * @param start - The start the request was offered with. A start the
   * activity does not follow, such as one whose offer was refused or found
   * its reply id already followed, changes nothing.
   * @remarks A freed slot goes at once to the request that has waited
   * longest, which then prepares its first round and whose offer resolves.
   * A request removed while it waits leaves the line, and its offer, if it
   * still waits, rejects.
   */
  public removeRequest(start: AgentRequestStart): void {
    const request = this.#requests.get(start.requestId)
    if (request?.start !== start) return
    this.#requests.delete(start.requestId)
    if (request.step.kind === "waiting") {
      request.slot.reject(new Error(REMOVED_WHILE_WAITING_MESSAGE))
      return
    }
    this.#startFirstWaitingRequest()
  }

  /**
   * Lists the requests the agent is working on, waiting ones included.
   * @returns A frozen list in offer order, so every request that holds a
   * slot comes before the waiting ones, which follow in line order; later
   * changes leave it as it was.
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

  /**
   * Follows an offered request with a free slot, or waiting for one, as the
   * limits allow.
   * @param start - The offered request.
   * @returns The followed request, its slot resolved when it holds one; or
   * undefined, following nothing, when every slot is held and the line is
   * full.
   */
  #addOfferedRequest(start: AgentRequestStart): FollowedRequest | undefined {
    const waitingCount = this.#calculateWaitingRequestCount()
    const heldCount = this.#requests.size - waitingCount
    const holdsSlot = heldCount < this.#limits.slotCount
    if (!holdsSlot && waitingCount >= this.#limits.waitingLimit)
      return undefined
    const request: FollowedRequest = {
      start,
      step: holdsSlot ? FIRST_ROUND_STEP : WAITING_STEP,
      toolCalls: NO_TOOL_CALLS,
      slot: Promise.withResolvers<void>()
    }
    if (holdsSlot) request.slot.resolve()
    this.#requests.set(start.requestId, request)
    return request
  }

  /**
   * Calculates how many requests wait for a slot.
   * @returns How many followed requests are waiting.
   */
  #calculateWaitingRequestCount(): number {
    let waitingCount = 0
    for (const request of this.#requests.values())
      if (request.step.kind === "waiting") waitingCount += 1
    return waitingCount
  }

  /**
   * Finds a followed request that holds a slot.
   * @param requestId - Reply id of the request.
   * @returns The request; undefined when it is not followed or still waits.
   */
  #findSlotHolder(requestId: string): FollowedRequest | undefined {
    const request = this.#requests.get(requestId)
    return request?.step.kind === "waiting" ? undefined : request
  }

  /**
   * Hands a free slot to the request that has waited longest, if any waits:
   * it prepares its first round and its offer resolves.
   */
  #startFirstWaitingRequest(): void {
    for (const request of this.#requests.values()) {
      if (request.step.kind !== "waiting") continue
      request.step = FIRST_ROUND_STEP
      request.slot.resolve()
      return
    }
  }
}
