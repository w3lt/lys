import { describe, expect, it } from "vitest"
import AgentActivity, {
  type AgentRequestStart
} from "../../../../src/modules/agent/agentActivity"
import {
  createFixtureUuidV7,
  createReasoningPart,
  createTextPart,
  createToolCallPart
} from "../../support/conversationFixtures"

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

/**
 * Creates an activity with the request of {@link START} started.
 *
 * @returns The activity.
 */
function createStartedActivity(): AgentActivity {
  const activity = new AgentActivity()
  activity.addRequest(START)
  return activity
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
  it("lists no request before one starts", () => {
    expect(new AgentActivity().listRequests()).toEqual([])
  })

  it("lists a started request as preparing its first round", () => {
    expect(createStartedActivity().listRequests()).toEqual([
      {
        requestId: REQUEST_ID,
        conversationId: START.conversationId,
        model: START.model,
        startedAt: START.startedAt,
        step: { kind: "preparing", round: 0 }
      }
    ])
  })

  it("shows a stored reasoning part as thinking and a stored text part as writing, in the part's round", () => {
    const activity = createStartedActivity()

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

  it("shows a stored tool call as using tools, replacing a call's status when it changes", () => {
    const activity = createStartedActivity()

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

  it("shows a running client tool as running in the app", () => {
    const activity = createStartedActivity()

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
  ] as const)("shows a %s call with that status", (status, state) => {
    const activity = createStartedActivity()

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

  it("keeps the round's earlier calls when text comes between two calls", () => {
    const activity = createStartedActivity()

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

  it("shows a new round as preparing it, without the previous round's calls", () => {
    const activity = createStartedActivity()
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

  it("lists overlapping requests in start order, each with its own step", () => {
    const activity = createStartedActivity()
    activity.addRequest({
      ...START,
      requestId: OTHER_REQUEST_ID,
      startedAt: "2026-10-24T10:01:00.000Z"
    })

    activity.updateRequestStep(
      OTHER_REQUEST_ID,
      createTextPart({ sequence: 2, round: 0, content: "Hi" })
    )

    expect(
      activity
        .listRequests()
        .map((request) => [request.requestId, request.step.kind])
    ).toEqual([
      [REQUEST_ID, "preparing"],
      [OTHER_REQUEST_ID, "writing"]
    ])
  })

  it("removes an ended request and keeps the others", () => {
    const activity = createStartedActivity()
    activity.addRequest({ ...START, requestId: OTHER_REQUEST_ID })

    activity.removeRequest(REQUEST_ID)

    expect(activity.listRequests().map((request) => request.requestId)).toEqual(
      [OTHER_REQUEST_ID]
    )
  })

  it("ignores rounds, parts, and ends of a request it does not follow", () => {
    const activity = createStartedActivity()

    activity.updateRequestRound(OTHER_REQUEST_ID, 1)
    activity.updateRequestStep(
      OTHER_REQUEST_ID,
      createTextPart({ sequence: 2, round: 0, content: "Hi" })
    )
    activity.removeRequest(OTHER_REQUEST_ID)

    expect(activity.listRequests()).toEqual([
      expect.objectContaining({
        requestId: REQUEST_ID,
        step: { kind: "preparing", round: 0 }
      })
    ])
  })

  it("returns a frozen list that later changes leave as it was", () => {
    const activity = createStartedActivity()
    activity.updateRequestStep(
      REQUEST_ID,
      createCall(3, BACKEND_TOOL_NAME, "awaiting-approval")
    )

    const listed = activity.listRequests()
    activity.updateRequestStep(
      REQUEST_ID,
      createCall(3, BACKEND_TOOL_NAME, "running")
    )
    activity.removeRequest(REQUEST_ID)

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
