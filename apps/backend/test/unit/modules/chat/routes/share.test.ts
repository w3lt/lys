import type { ChatGenerationEvent } from "@lys/protocol"
import { describe, expect, it } from "vitest"
import ReplyEventSubscription from "../../../../../src/modules/chat/replyEventSubscription"
import {
  createEventSender,
  openReplyEventStream,
  type ReplySse
} from "../../../../../src/modules/chat/routes/share"
import {
  registerChatSseRoute,
  createChatSseTestApp,
  sendChatSseRouteRequest
} from "../../../support/chatSseRoute"
import {
  createFixtureUuidV7,
  FIXTURE_TIMESTAMP
} from "../../../support/conversationFixtures"
import { waitForMicrotasks } from "../../../support/microtasks"
import { createSettlementReader } from "../../../support/settlement"

/** Identity of the reply part the sample fragments extend. */
const STREAMED_PART_ID = createFixtureUuidV7(12)

/**
 * Creates a sample event appending one fragment to a reply part.
 *
 * @param content - The fragment.
 * @returns The `reply-part-delta` event.
 */
function createFragmentEvent(content: string): ChatGenerationEvent {
  return {
    type: "reply-part-delta",
    partId: STREAMED_PART_ID,
    content,
    updatedAt: FIXTURE_TIMESTAMP
  }
}

/** Connection capability read by {@link openReplyEventStream}. */
type FollowedConnection = Pick<ReplySse, "onClose" | "isConnected">

/**
 * Creates an open connection whose closure the case triggers.
 *
 * @returns The connection and a trigger that marks it closed and runs the
 * close callbacks registered so far.
 * @remarks Like the SSE plugin, a callback registered after closure never
 * runs.
 */
function createControlledConnection() {
  const closeCallbacks: (() => void)[] = []
  let isConnected = true
  const connection: FollowedConnection = {
    get isConnected() {
      return isConnected
    },
    onClose: (callback) => {
      closeCallbacks.push(callback)
    }
  }
  return {
    connection,
    close: () => {
      isConnected = false
      for (const callback of closeCallbacks.splice(0)) callback()
    }
  }
}

describe("createEventSender", () => {
  it("sends each event named by its type with the event as JSON data", async () => {
    const { app } = await createChatSseTestApp()
    registerChatSseRoute(app, async (_request, reply) => {
      const sendEvent = createEventSender<ChatGenerationEvent>(reply.sse)
      await sendEvent(createFragmentEvent("Hi"))
      await sendEvent({ type: "done", finishReason: "stop" })
    })

    const response = await sendChatSseRouteRequest(app)

    expect(response.contentType).toBe("text/event-stream")
    expect(response.events).toEqual([
      {
        event: "reply-part-delta",
        data: createFragmentEvent("Hi")
      },
      { event: "done", data: { type: "done", finishReason: "stop" } }
    ])
  })

  it("rejects when the connection is closed", async () => {
    const { app } = await createChatSseTestApp()
    let failure: unknown
    registerChatSseRoute(app, async (_request, reply) => {
      reply.sse.close()
      failure = await createEventSender<ChatGenerationEvent>(reply.sse)(
        createFragmentEvent("late")
      ).catch((error: unknown) => error)
    })

    await sendChatSseRouteRequest(app)

    expect(failure).toBeInstanceOf(Error)
  })
})

describe("openReplyEventStream", () => {
  it("ends once its follower ended and every accepted event was written", async () => {
    const { app } = await createChatSseTestApp()
    registerChatSseRoute(app, async (_request, reply) => {
      const subscription = new ReplyEventSubscription<ChatGenerationEvent>(
        createEventSender(reply.sse)
      )
      const stream = openReplyEventStream(reply.sse, subscription)
      subscription.handleStreamEvent(createFragmentEvent("Hi"))
      subscription.handleStreamEvent({ type: "done", finishReason: "stop" })
      subscription.close()
      await stream
    })

    const response = await sendChatSseRouteRequest(app)

    expect(response.events).toEqual([
      {
        event: "reply-part-delta",
        data: createFragmentEvent("Hi")
      },
      { event: "done", data: { type: "done", finishReason: "stop" } }
    ])
  })

  it("ends its follower when the connection closes", async () => {
    const { app } = await createChatSseTestApp()
    let acceptedAfterClose: boolean | undefined
    registerChatSseRoute(app, async (_request, reply) => {
      const subscription = new ReplyEventSubscription<ChatGenerationEvent>(
        createEventSender(reply.sse)
      )
      const stream = openReplyEventStream(reply.sse, subscription)
      reply.sse.close()
      await stream
      acceptedAfterClose = subscription.handleStreamEvent(
        createFragmentEvent("late")
      )
    })

    await sendChatSseRouteRequest(app)

    expect(acceptedAfterClose).toBe(false)
  })

  it("ends its follower at once when the connection closed before the stream opened", async () => {
    const { app } = await createChatSseTestApp()
    let acceptedAfterOpen: boolean | undefined
    registerChatSseRoute(app, async (_request, reply) => {
      const subscription = new ReplyEventSubscription<ChatGenerationEvent>(
        createEventSender(reply.sse)
      )
      reply.sse.close()
      await openReplyEventStream(reply.sse, subscription)
      acceptedAfterOpen = subscription.handleStreamEvent(
        createFragmentEvent("late")
      )
    })

    await sendChatSseRouteRequest(app)

    expect(acceptedAfterOpen).toBe(false)
  })

  it("does not wait for a write still pending when the connection closes", async () => {
    const { connection, close } = createControlledConnection()
    const subscription = new ReplyEventSubscription<ChatGenerationEvent>(
      () => new Promise<void>(() => {})
    )
    subscription.handleStreamEvent(createFragmentEvent("stalled"))
    const closedState = createSettlementReader(subscription.closed)

    const stream = openReplyEventStream(connection, subscription)
    close()

    await expect(stream).resolves.toBeUndefined()
    await waitForMicrotasks()
    expect(closedState()).toBe("pending")
  })
})
