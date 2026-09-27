import { describe, expect, it } from "vitest"
import {
  createAbortSignal,
  createEventSender
} from "../../../../src/modules/chat/chat/share"
import {
  addChatSseRoute,
  createChatSseTestApp,
  requestChatSseRoute
} from "../../../support/chatSseRoute"

describe("createAbortSignal", () => {
  it("stays unaborted while the SSE connection is open", async () => {
    const { app } = await createChatSseTestApp()
    let abortedWhileOpen: boolean | undefined
    addChatSseRoute(app, async (_request, reply) => {
      abortedWhileOpen = createAbortSignal(reply).aborted
    })

    await requestChatSseRoute(app)

    expect(abortedWhileOpen).toBe(false)
  })

  it("aborts when the SSE connection closes", async () => {
    const { app } = await createChatSseTestApp()
    let signal: AbortSignal | undefined
    addChatSseRoute(app, async (_request, reply) => {
      signal = createAbortSignal(reply)
      reply.sse.close()
    })

    await requestChatSseRoute(app)

    expect(signal?.aborted).toBe(true)
  })

  it("aborts when the route handler finishes and the plugin closes the stream", async () => {
    const { app } = await createChatSseTestApp()
    let signal: AbortSignal | undefined
    addChatSseRoute(app, async (_request, reply) => {
      signal = createAbortSignal(reply)
      await reply.sse.send({
        event: "delta",
        data: { type: "delta", content: "Hi" }
      })
    })

    await requestChatSseRoute(app)

    expect(signal?.aborted).toBe(true)
  })
})

describe("createEventSender", () => {
  it("sends each event named by its type with the event as JSON data", async () => {
    const { app } = await createChatSseTestApp()
    addChatSseRoute(app, async (_request, reply) => {
      const sendEvent = createEventSender(reply)
      await sendEvent({ type: "delta", content: "Hi" })
      await sendEvent({ type: "done", finishReason: "stop" })
    })

    const response = await requestChatSseRoute(app)

    expect(response.contentType).toBe("text/event-stream")
    expect(response.events).toEqual([
      { event: "delta", data: { type: "delta", content: "Hi" } },
      { event: "done", data: { type: "done", finishReason: "stop" } }
    ])
  })

  it("rejects when the connection is closed", async () => {
    const { app } = await createChatSseTestApp()
    let failure: unknown
    addChatSseRoute(app, async (_request, reply) => {
      reply.sse.close()
      failure = await createEventSender(reply)({
        type: "delta",
        content: "late"
      }).catch((error: unknown) => error)
    })

    await requestChatSseRoute(app)

    expect(failure).toBeInstanceOf(Error)
  })
})
