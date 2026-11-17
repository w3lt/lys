import { describe, expect, it } from "vitest"
import {
  ActivityStreamOpenError,
  readActivityEvents
} from "@/lib/apis/http/activity"
import {
  ACTIVITY_ROUTE,
  buildActivityApprovalPrompt,
  buildActivityReply,
  buildIdleActivityRoute
} from "../../../support/activityFixtures"
import {
  buildJsonResponse,
  FIXTURE_BACKEND_URL,
  startBackendEventStream,
  startBackendFake
} from "../../../support/backendFake"
import {
  buildJob,
  FIXTURE_CONVERSATION_ID,
  FIXTURE_JOB_ID,
  FIXTURE_JOB_REPLY_ID,
  FIXTURE_WAKE_REPLY_ID
} from "../../../support/conversationFixtures"
import { waitForMicrotasks } from "../../../support/settlement"
import { buildToolCall } from "../../../support/toolFixtures"

/**
 * Builds a `reply-ended` event of the fixture job's reply as a backend could
 * send it, without validating it.
 *
 * @param status - Status the event carries, valid or not.
 * @returns The untrusted event.
 */
function buildReplyEndedEvent(status: unknown): object {
  return {
    type: "reply-ended",
    conversationId: FIXTURE_JOB_ID,
    parentConversationId: FIXTURE_CONVERSATION_ID,
    assistantMessageId: FIXTURE_JOB_REPLY_ID,
    status
  }
}

describe("readActivityEvents", () => {
  it("opens the stream at the caller's backend origin, asking for events, uncached, under the caller's signal", async () => {
    const backend = startBackendFake({
      [ACTIVITY_ROUTE]: buildIdleActivityRoute()
    })
    const signal = new AbortController().signal

    const events = readActivityEvents({
      backendUrl: FIXTURE_BACKEND_URL,
      signal
    })

    await expect(events.next()).resolves.toEqual({
      done: false,
      value: { type: "activity-snapshot", replies: [] }
    })
    await events.return()
    expect(backend.requests).toHaveLength(1)
    expect(backend.requests[0]).toMatchObject({
      url: `${FIXTURE_BACKEND_URL}/api/v1/activity/events`,
      cache: "no-store",
      signal
    })
    expect(backend.requests[0]?.headers.get("Accept")).toBe("text/event-stream")
  })

  it("yields the snapshot and every later event in order until the backend closes the stream", async () => {
    const stream = startBackendEventStream()
    startBackendFake({ [ACTIVITY_ROUTE]: () => stream.response })
    const jobReply = {
      conversationId: FIXTURE_JOB_ID,
      parentConversationId: FIXTURE_CONVERSATION_ID,
      assistantMessageId: FIXTURE_JOB_REPLY_ID
    }
    const snapshot = {
      type: "activity-snapshot",
      replies: [
        buildActivityReply({
          pendingToolApprovals: [buildToolCall(70, "read_text_file")]
        })
      ]
    }
    const laterEvents = [
      {
        type: "reply-started",
        conversationId: FIXTURE_CONVERSATION_ID,
        parentConversationId: null,
        assistantMessageId: FIXTURE_WAKE_REPLY_ID
      },
      {
        type: "job-updated",
        parentConversationId: FIXTURE_CONVERSATION_ID,
        job: buildJob({ latestNote: "Reading three feeds." })
      },
      {
        type: "tool-call",
        ...jobReply,
        call: buildToolCall(68, "find_files")
      },
      {
        type: "tool-approval",
        ...jobReply,
        ...buildActivityApprovalPrompt(buildToolCall(69, "read_text_file"))
      },
      { type: "reply-ended", ...jobReply, status: "completed" }
    ]
    const events = readActivityEvents({
      backendUrl: FIXTURE_BACKEND_URL,
      signal: new AbortController().signal
    })

    stream.sendEvent(snapshot)
    expect((await events.next()).value).toEqual(snapshot)
    laterEvents.forEach((event) => stream.sendEvent(event))
    stream.close()
    const received: unknown[] = []
    for await (const event of events) received.push(event)

    expect(received).toEqual(laterEvents)
  })

  it("throws when an event does not match the contract", async () => {
    const stream = startBackendEventStream()
    startBackendFake({ [ACTIVITY_ROUTE]: () => stream.response })
    stream.sendEvent({ type: "reply-ended" })

    const events = readActivityEvents({
      backendUrl: FIXTURE_BACKEND_URL,
      signal: new AbortController().signal
    })

    await expect(events.next()).rejects.toMatchObject({ name: "ZodError" })
    expect(stream.isCancelled()).toBe(true)
  })

  it.each([
    ["a completed reply", "completed"],
    ["an interrupted reply", "interrupted"],
    ["a failed reply", "failed"],
    ["a reply no longer stored or not read", null]
  ] as const)("reads the end of %s", async (_label, status) => {
    const stream = startBackendEventStream()
    startBackendFake({ [ACTIVITY_ROUTE]: () => stream.response })
    stream.sendEvent(buildReplyEndedEvent(status))

    const events = readActivityEvents({
      backendUrl: FIXTURE_BACKEND_URL,
      signal: new AbortController().signal
    })

    await expect(events.next()).resolves.toEqual({
      done: false,
      value: buildReplyEndedEvent(status)
    })
  })

  it("throws when an ended reply's status is streaming, which no ended reply has", async () => {
    const stream = startBackendEventStream()
    startBackendFake({ [ACTIVITY_ROUTE]: () => stream.response })
    stream.sendEvent(buildReplyEndedEvent("streaming"))

    const events = readActivityEvents({
      backendUrl: FIXTURE_BACKEND_URL,
      signal: new AbortController().signal
    })

    await expect(events.next()).rejects.toMatchObject({ name: "ZodError" })
  })

  it.each([
    ["a refusal", 503, () => buildJsonResponse(503, {})],
    [
      "an answer without a body",
      204,
      () => new Response(null, { status: 204 })
    ],
    [
      "an answer that is not an event stream",
      200,
      () => buildJsonResponse(200, { type: "activity-snapshot", replies: [] })
    ]
  ])(
    "throws the open failure, naming the status, for %s",
    async (_label, status, route) => {
      startBackendFake({ [ACTIVITY_ROUTE]: route })

      const events = readActivityEvents({
        backendUrl: FIXTURE_BACKEND_URL,
        signal: new AbortController().signal
      })

      await expect(events.next()).rejects.toStrictEqual(
        new ActivityStreamOpenError(status)
      )
    }
  )

  it("cancels the body of an answer it cannot read as the stream", async () => {
    let isBodyCancelled = false
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        isBodyCancelled = true
      }
    })
    startBackendFake({
      [ACTIVITY_ROUTE]: () =>
        new Response(body, {
          status: 503,
          headers: { "Content-Type": "application/json" }
        })
    })

    const events = readActivityEvents({
      backendUrl: FIXTURE_BACKEND_URL,
      signal: new AbortController().signal
    })

    await expect(events.next()).rejects.toThrow(
      "The backend could not open the activity stream (HTTP 503)."
    )
    await waitForMicrotasks()
    expect(isBodyCancelled).toBe(true)
  })

  it("cancels the stream when the consumer stops reading early", async () => {
    const stream = startBackendEventStream()
    startBackendFake({ [ACTIVITY_ROUTE]: () => stream.response })
    stream.sendEvent({ type: "activity-snapshot", replies: [] })
    const events = readActivityEvents({
      backendUrl: FIXTURE_BACKEND_URL,
      signal: new AbortController().signal
    })
    await events.next()

    await events.return()

    // The cancel reaches the route's body through the decoding pipes on
    // later continuations.
    await waitForMicrotasks()
    expect(stream.isCancelled()).toBe(true)
  })

  it("cancels the stream when the signal aborts", async () => {
    const stream = startBackendEventStream()
    startBackendFake({ [ACTIVITY_ROUTE]: () => stream.response })
    stream.sendEvent({ type: "activity-snapshot", replies: [] })
    const controller = new AbortController()
    const events = readActivityEvents({
      backendUrl: FIXTURE_BACKEND_URL,
      signal: controller.signal
    })
    await events.next()
    const pendingRead = events.next()

    controller.abort()

    await expect(pendingRead).rejects.toMatchObject({ name: "AbortError" })
    expect(stream.isCancelled()).toBe(true)
  })
})
