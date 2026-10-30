import { describe, expect, it } from "vitest"
import AgentActivity, {
  AgentRequestLimitError,
  type AgentRequestLimits,
  type AgentRequestStart
} from "../../../../src/modules/agent/agentActivity"
import {
  createFixtureUuidV7,
  createReasoningPart,
  createTextPart,
  createToolCallPart
} from "../../support/conversationFixtures"
import { waitForMicrotasks } from "../../support/microtasks"
import { createSettlementReader } from "../../support/settlement"

/** Reply of the request most cases start. */
const REQUEST_ID = createFixtureUuidV7(101)

/** Reply of a second request that overlaps the first. */
const OTHER_REQUEST_ID = createFixtureUuidV7(102)

/** Client tool the person's app runs. */
const CLIENT_TOOL_NAME = "read_text_file"

/** Backend tool the backend runs. */
const BACKEND_TOOL_NAME = "web_search"

/** Start of the request most cases follow. */
const START: AgentRequestStart = Object.freeze({
  requestId: REQUEST_ID,
  conversationId: createFixtureUuidV7(1),
  model: "qwen/qwen3-8b",
  startedAt: "2026-10-24T10:00:00.000Z",
  clientToolNames: new Set([CLIENT_TOOL_NAME])
})

/** Limits of most cases: two slots and room for one waiting request. */
const LIMITS: AgentRequestLimits = Object.freeze({
  slotCount: 2,
  waitingLimit: 1
})

/** Cancellation of an offer that no case stops. */
const UNSTOPPED_SIGNAL = new AbortController().signal

/** Starts of other requests than {@link START}, by reply sequence. */
const OTHER_STARTS = new Map<number, AgentRequestStart>()

/**
 * Builds the start of another request than {@link START}.
 *
 * @param sequence - Identity sequence of its reply.
 * @returns The start, with its own reply id; the same object for the same
 * sequence, as removing a request takes the start it was offered with.
 */
function buildOtherStart(sequence: number): AgentRequestStart {
  const known = OTHER_STARTS.get(sequence)
  if (known !== undefined) return known
  const start = Object.freeze({
    ...START,
    requestId: createFixtureUuidV7(sequence)
  })
  OTHER_STARTS.set(sequence, start)
  return start
}

/**
 * Creates an activity with the request of {@link START} started.
 *
 * @returns The activity, once the request holds a slot.
 */
async function createStartedActivity(): Promise<AgentActivity> {
  const activity = new AgentActivity(LIMITS)
  await expect(activity.offerRequest(START, UNSTOPPED_SIGNAL)).resolves.toEqual(
    { status: "started" }
  )
  return activity
}

/**
 * Lists each followed request's reply id and step kind.
 *
 * @param activity - The activity.
 * @returns Pairs in list order.
 */
function listRequestSteps(activity: AgentActivity) {
  return activity
    .listRequests()
    .map((request) => [request.requestId, request.step.kind])
}

/**
 * Creates a tool call in round 0 without arguments.
 *
 * @param sequence - Identity sequence of the call.
 * @param toolName - Called tool.
 * @param status - State of the call without a result.
 * @returns The stored call.
 */
function createCall(
  sequence: number,
  toolName: string,
  status: "awaiting-approval" | "running" | "interrupted"
) {
  return createToolCallPart(
    { sequence, round: 0, toolName, argumentText: "{}" },
    { status }
  )
}

describe("AgentActivity", () => {
  it("lists no request before one is offered", () => {
    expect(new AgentActivity(LIMITS).listRequests()).toEqual([])
  })

  it("lists a started request as preparing its first round", async () => {
    expect((await createStartedActivity()).listRequests()).toEqual([
      {
        requestId: REQUEST_ID,
        conversationId: START.conversationId,
        model: START.model,
        startedAt: START.startedAt,
        step: { kind: "preparing", round: 0 }
      }
    ])
  })

  it("shows a stored reasoning part as thinking and a stored text part as writing, in the part's round", async () => {
    const activity = await createStartedActivity()

    activity.updateRequestStep(REQUEST_ID, createReasoningPart(1, 0, "Hmm"))
    const thinking = activity.listRequests()[0]?.step
    activity.updateRequestStep(
      REQUEST_ID,
      createTextPart({ sequence: 2, round: 0, content: "Hi" })
    )

    expect(thinking).toEqual({ kind: "thinking", round: 0 })
    expect(activity.listRequests()[0]?.step).toEqual({
      kind: "writing",
      round: 0
    })
  })

  it("shows a stored tool call as using tools, replacing a call's status when it changes", async () => {
    const activity = await createStartedActivity()

    activity.updateRequestStep(
      REQUEST_ID,
      createCall(3, BACKEND_TOOL_NAME, "awaiting-approval")
    )
    activity.updateRequestStep(
      REQUEST_ID,
      createCall(4, BACKEND_TOOL_NAME, "awaiting-approval")
    )
    activity.updateRequestStep(
      REQUEST_ID,
      createCall(3, BACKEND_TOOL_NAME, "running")
    )

    expect(activity.listRequests()[0]?.step).toEqual({
      kind: "using-tools",
      round: 0,
      toolCalls: [
        {
          toolCallId: createFixtureUuidV7(3),
          toolName: BACKEND_TOOL_NAME,
          status: "running"
        },
        {
          toolCallId: createFixtureUuidV7(4),
          toolName: BACKEND_TOOL_NAME,
          status: "awaiting-approval"
        }
      ]
    })
  })

  it("shows a running client tool as running in the app", async () => {
    const activity = await createStartedActivity()

    activity.updateRequestStep(
      REQUEST_ID,
      createCall(3, CLIENT_TOOL_NAME, "running")
    )

    expect(activity.listRequests()[0]?.step).toMatchObject({
      toolCalls: [{ toolName: CLIENT_TOOL_NAME, status: "running-in-app" }]
    })
  })

  it.each([
    ["succeeded", { status: "succeeded", result: "Found", sourceNumbers: [] }],
    ["failed", { status: "failed", result: "Broke" }],
    ["rejected", { status: "rejected", result: "Not allowed" }],
    ["interrupted", { status: "interrupted" }]
  ] as const)("shows a %s call with that status", async (status, state) => {
    const activity = await createStartedActivity()

    activity.updateRequestStep(
      REQUEST_ID,
      createToolCallPart(
        {
          sequence: 3,
          round: 0,
          toolName: CLIENT_TOOL_NAME,
          argumentText: "{}"
        },
        state
      )
    )

    expect(activity.listRequests()[0]?.step).toMatchObject({
      toolCalls: [{ status }]
    })
  })

  it("keeps the round's earlier calls when text comes between two calls", async () => {
    const activity = await createStartedActivity()

    activity.updateRequestStep(
      REQUEST_ID,
      createCall(3, BACKEND_TOOL_NAME, "running")
    )
    activity.updateRequestStep(
      REQUEST_ID,
      createTextPart({ sequence: 4, round: 0, content: "Also" })
    )
    activity.updateRequestStep(
      REQUEST_ID,
      createCall(5, CLIENT_TOOL_NAME, "awaiting-approval")
    )

    expect(activity.listRequests()[0]?.step).toMatchObject({
      kind: "using-tools",
      toolCalls: [
        { toolCallId: createFixtureUuidV7(3) },
        { toolCallId: createFixtureUuidV7(5) }
      ]
    })
  })

  it("shows a new round as preparing it, without the previous round's calls", async () => {
    const activity = await createStartedActivity()
    activity.updateRequestStep(
      REQUEST_ID,
      createCall(3, BACKEND_TOOL_NAME, "running")
    )

    activity.updateRequestRound(REQUEST_ID, 1)
    const preparing = activity.listRequests()[0]?.step
    activity.updateRequestStep(
      REQUEST_ID,
      createToolCallPart(
        {
          sequence: 6,
          round: 1,
          toolName: BACKEND_TOOL_NAME,
          argumentText: "{}"
        },
        { status: "running" }
      )
    )

    expect(preparing).toEqual({ kind: "preparing", round: 1 })
    expect(activity.listRequests()[0]?.step).toEqual({
      kind: "using-tools",
      round: 1,
      toolCalls: [
        {
          toolCallId: createFixtureUuidV7(6),
          toolName: BACKEND_TOOL_NAME,
          status: "running"
        }
      ]
    })
  })

  it("lists overlapping requests in start order, each with its own step", async () => {
    const activity = await createStartedActivity()
    await activity.offerRequest(
      {
        ...START,
        requestId: OTHER_REQUEST_ID,
        startedAt: "2026-10-24T10:01:00.000Z"
      },
      UNSTOPPED_SIGNAL
    )

    activity.updateRequestStep(
      OTHER_REQUEST_ID,
      createTextPart({ sequence: 2, round: 0, content: "Hi" })
    )

    expect(listRequestSteps(activity)).toEqual([
      [REQUEST_ID, "preparing"],
      [OTHER_REQUEST_ID, "writing"]
    ])
  })

  it("removes an ended request and keeps the others", async () => {
    const activity = await createStartedActivity()
    await activity.offerRequest(
      { ...START, requestId: OTHER_REQUEST_ID },
      UNSTOPPED_SIGNAL
    )

    activity.removeRequest(START)

    expect(activity.listRequests().map((request) => request.requestId)).toEqual(
      [OTHER_REQUEST_ID]
    )
  })

  it("ignores rounds, parts, and ends of a request it does not follow", async () => {
    const activity = await createStartedActivity()

    activity.updateRequestRound(OTHER_REQUEST_ID, 1)
    activity.updateRequestStep(
      OTHER_REQUEST_ID,
      createTextPart({ sequence: 2, round: 0, content: "Hi" })
    )
    activity.removeRequest({ ...START, requestId: OTHER_REQUEST_ID })

    expect(activity.listRequests()).toEqual([
      expect.objectContaining({
        requestId: REQUEST_ID,
        step: { kind: "preparing", round: 0 }
      })
    ])
  })

  it("returns a frozen list that later changes leave as it was", async () => {
    const activity = await createStartedActivity()
    activity.updateRequestStep(
      REQUEST_ID,
      createCall(3, BACKEND_TOOL_NAME, "awaiting-approval")
    )

    const listed = activity.listRequests()
    activity.updateRequestStep(
      REQUEST_ID,
      createCall(3, BACKEND_TOOL_NAME, "running")
    )
    activity.removeRequest(START)

    expect(Object.isFrozen(listed)).toBe(true)
    expect(Object.isFrozen(listed[0])).toBe(true)
    expect(Object.isFrozen(listed[0]?.step)).toBe(true)
    expect(listed[0]?.step).toEqual({
      kind: "using-tools",
      round: 0,
      toolCalls: [
        {
          toolCallId: createFixtureUuidV7(3),
          toolName: BACKEND_TOOL_NAME,
          status: "awaiting-approval"
        }
      ]
    })
  })
})

describe("AgentActivity request slots", () => {
  /**
   * Creates an activity whose slots are all held by started requests.
   *
   * @param limits - Limits of the activity.
   * @returns The activity, its slots held by requests with reply sequences
   * 101, 102, and so on, in offer order.
   */
  async function createFullActivity(
    limits: AgentRequestLimits
  ): Promise<AgentActivity> {
    const activity = new AgentActivity(limits)
    for (let index = 0; index < limits.slotCount; index += 1)
      await activity.offerRequest(
        buildOtherStart(101 + index),
        UNSTOPPED_SIGNAL
      )
    return activity
  }

  it("starts each request at once while a slot is free", async () => {
    const activity = new AgentActivity(LIMITS)

    const offers = await Promise.all([
      activity.offerRequest(buildOtherStart(101), UNSTOPPED_SIGNAL),
      activity.offerRequest(buildOtherStart(102), UNSTOPPED_SIGNAL)
    ])

    expect(offers).toEqual([{ status: "started" }, { status: "started" }])
    expect(listRequestSteps(activity)).toEqual([
      [createFixtureUuidV7(101), "preparing"],
      [createFixtureUuidV7(102), "preparing"]
    ])
  })

  it("lists a request that finds every slot held as waiting, after the requests that hold slots, and does not start it", async () => {
    const activity = await createFullActivity(LIMITS)

    const offer = createSettlementReader(
      activity.offerRequest(buildOtherStart(103), UNSTOPPED_SIGNAL)
    )
    await waitForMicrotasks()

    expect(offer()).toBe("pending")
    expect(activity.listRequests().at(-1)).toEqual({
      requestId: createFixtureUuidV7(103),
      conversationId: START.conversationId,
      model: START.model,
      startedAt: START.startedAt,
      step: { kind: "waiting" }
    })
  })

  it("refuses a request that finds every slot held and the line full, without following it", async () => {
    const activity = await createFullActivity(LIMITS)
    const waiting = createSettlementReader(
      activity.offerRequest(buildOtherStart(103), UNSTOPPED_SIGNAL)
    )

    const offer = await activity.offerRequest(
      buildOtherStart(104),
      UNSTOPPED_SIGNAL
    )

    expect(offer).toEqual({ status: "refused", limits: LIMITS })
    expect(waiting()).toBe("pending")
    expect(listRequestSteps(activity)).toEqual([
      [createFixtureUuidV7(101), "preparing"],
      [createFixtureUuidV7(102), "preparing"],
      [createFixtureUuidV7(103), "waiting"]
    ])
  })

  it("refuses every request that finds the slots held when no request may wait", async () => {
    const limits = Object.freeze({ slotCount: 1, waitingLimit: 0 })
    const activity = await createFullActivity(limits)

    await expect(
      activity.offerRequest(buildOtherStart(102), UNSTOPPED_SIGNAL)
    ).resolves.toEqual({ status: "refused", limits })
    expect(activity.listRequests()).toHaveLength(1)
  })

  it("hands a freed slot to the request that has waited longest, which prepares its first round", async () => {
    const activity = await createFullActivity({ slotCount: 1, waitingLimit: 2 })
    const first = activity.offerRequest(buildOtherStart(102), UNSTOPPED_SIGNAL)
    const second = createSettlementReader(
      activity.offerRequest(buildOtherStart(103), UNSTOPPED_SIGNAL)
    )

    activity.removeRequest(buildOtherStart(101))

    await expect(first).resolves.toEqual({ status: "started" })
    expect(second()).toBe("pending")
    expect(activity.listRequests()).toEqual([
      expect.objectContaining({
        requestId: createFixtureUuidV7(102),
        step: { kind: "preparing", round: 0 }
      }),
      expect.objectContaining({
        requestId: createFixtureUuidV7(103),
        step: { kind: "waiting" }
      })
    ])
  })

  it("keeps a slot held by a request whatever step it is at, so a later request waits", async () => {
    const activity = await createFullActivity({ slotCount: 1, waitingLimit: 1 })
    activity.updateRequestStep(
      createFixtureUuidV7(101),
      createCall(3, CLIENT_TOOL_NAME, "awaiting-approval")
    )

    const offer = createSettlementReader(
      activity.offerRequest(buildOtherStart(102), UNSTOPPED_SIGNAL)
    )
    await waitForMicrotasks()

    expect(offer()).toBe("pending")
    expect(listRequestSteps(activity)).toEqual([
      [createFixtureUuidV7(101), "using-tools"],
      [createFixtureUuidV7(102), "waiting"]
    ])
  })

  it("ignores rounds and parts of a waiting request, which keeps waiting", async () => {
    const activity = await createFullActivity({ slotCount: 1, waitingLimit: 1 })
    const waitingId = createFixtureUuidV7(102)
    const offer = createSettlementReader(
      activity.offerRequest(buildOtherStart(102), UNSTOPPED_SIGNAL)
    )

    activity.updateRequestRound(waitingId, 0)
    activity.updateRequestStep(
      waitingId,
      createTextPart({ sequence: 2, round: 0, content: "Hi" })
    )
    await waitForMicrotasks()

    expect(offer()).toBe("pending")
    expect(activity.listRequests()[1]?.step).toEqual({ kind: "waiting" })
  })

  it("rejects a waiting request's offer with the abort reason when it is stopped, and lists it as waiting until it is removed", async () => {
    const activity = await createFullActivity({ slotCount: 1, waitingLimit: 1 })
    const stop = new AbortController()
    const reason = new Error("Stopped")
    const offer = activity.offerRequest(buildOtherStart(102), stop.signal)

    stop.abort(reason)

    await expect(offer).rejects.toBe(reason)
    expect(listRequestSteps(activity)).toEqual([
      [createFixtureUuidV7(101), "preparing"],
      [createFixtureUuidV7(102), "waiting"]
    ])
  })

  it("rejects at once the offer of a request that must wait when its signal already aborted", async () => {
    const activity = await createFullActivity({ slotCount: 1, waitingLimit: 1 })
    const reason = new Error("Stopped before")

    await expect(
      activity.offerRequest(buildOtherStart(102), AbortSignal.abort(reason))
    ).rejects.toBe(reason)
  })

  it("starts a request that finds a free slot, whatever its signal", async () => {
    const activity = new AgentActivity(LIMITS)

    await expect(
      activity.offerRequest(START, AbortSignal.abort(new Error("Stopped")))
    ).resolves.toEqual({ status: "started" })
  })

  it("frees a stopped request's place in line, not a slot, and hands the next free slot past it", async () => {
    const activity = await createFullActivity({ slotCount: 1, waitingLimit: 1 })
    const stop = new AbortController()
    const stopped = activity.offerRequest(buildOtherStart(102), stop.signal)
    stop.abort(new Error("Stopped"))
    await expect(stopped).rejects.toThrow("Stopped")

    activity.removeRequest(buildOtherStart(102))
    const later = createSettlementReader(
      activity.offerRequest(buildOtherStart(103), UNSTOPPED_SIGNAL)
    )
    await waitForMicrotasks()
    const waitedForHeldSlot = later()
    activity.removeRequest(buildOtherStart(101))
    await waitForMicrotasks()

    expect(waitedForHeldSlot).toBe("pending")
    expect(later()).toBe("fulfilled")
    expect(listRequestSteps(activity)).toEqual([
      [createFixtureUuidV7(103), "preparing"]
    ])
  })

  it("keeps the request behind a removed waiting one waiting until a slot frees", async () => {
    const activity = await createFullActivity({ slotCount: 1, waitingLimit: 2 })
    const removed = createSettlementReader(
      activity.offerRequest(buildOtherStart(102), UNSTOPPED_SIGNAL)
    )
    const behind = createSettlementReader(
      activity.offerRequest(buildOtherStart(103), UNSTOPPED_SIGNAL)
    )

    activity.removeRequest(buildOtherStart(102))
    await waitForMicrotasks()
    const behindAfterRemoval = behind()
    const stepsAfterRemoval = listRequestSteps(activity)
    activity.removeRequest(buildOtherStart(101))
    await waitForMicrotasks()

    expect(removed()).toBe("rejected")
    expect(behindAfterRemoval).toBe("pending")
    expect(stepsAfterRemoval).toEqual([
      [createFixtureUuidV7(101), "preparing"],
      [createFixtureUuidV7(103), "waiting"]
    ])
    expect(behind()).toBe("fulfilled")
    expect(listRequestSteps(activity)).toEqual([
      [createFixtureUuidV7(103), "preparing"]
    ])
  })

  it("rejects the offer of a waiting request that is removed before it gets a slot", async () => {
    const activity = await createFullActivity({ slotCount: 1, waitingLimit: 1 })
    const offer = activity.offerRequest(buildOtherStart(102), UNSTOPPED_SIGNAL)

    activity.removeRequest(buildOtherStart(102))

    await expect(offer).rejects.toThrow(
      "The request was removed while it waited for a request slot"
    )
    expect(activity.listRequests()).toHaveLength(1)
  })

  it("rejects the offer of a reply id it already follows and leaves that request as it was", async () => {
    const activity = await createStartedActivity()
    activity.updateRequestStep(
      REQUEST_ID,
      createTextPart({ sequence: 2, round: 0, content: "Hi" })
    )

    await expect(
      activity.offerRequest(START, UNSTOPPED_SIGNAL)
    ).rejects.toThrow("The request is already followed")
    expect(listRequestSteps(activity)).toEqual([[REQUEST_ID, "writing"]])
  })

  it("keeps a request, and its slot, when the start of a refused duplicate offer is removed", async () => {
    const activity = new AgentActivity({ slotCount: 1, waitingLimit: 1 })
    await activity.offerRequest(START, UNSTOPPED_SIGNAL)
    const duplicate = Object.freeze({ ...START })
    await expect(
      activity.offerRequest(duplicate, UNSTOPPED_SIGNAL)
    ).rejects.toThrow("The request is already followed")
    const later = createSettlementReader(
      activity.offerRequest(buildOtherStart(102), UNSTOPPED_SIGNAL)
    )

    activity.removeRequest(duplicate)
    await waitForMicrotasks()

    expect(later()).toBe("pending")
    expect(listRequestSteps(activity)).toEqual([
      [REQUEST_ID, "preparing"],
      [createFixtureUuidV7(102), "waiting"]
    ])
  })
})

describe("AgentRequestLimitError", () => {
  it("is an Error that keeps the limits the agent reached and names them", () => {
    const failure = new AgentRequestLimitError(LIMITS)

    expect(failure).toBeInstanceOf(Error)
    expect(failure.limits).toBe(LIMITS)
    expect(failure.message).toBe(
      "The agent's request slots and line were full: slots held 2 of 2, requests waiting 1 of 1"
    )
  })
})
