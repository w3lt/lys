import {
  chatReplyEventSchema,
  chatReplyEventsApi,
  chatReplyNotFoundProblemSchema,
  chatReplyNotGeneratingProblemSchema,
  conversationNotFoundProblemSchema,
  stopChatReplyApi
} from "@lys/protocol"
import type { Conversation } from "@lys/share"
import { describe, expect, it, onTestFinished, vi, type Mock } from "vitest"
import SqliteConversationStore from "../../../../../src/di/services/conversationService"
import { updateFastifyWithHttpTransport } from "../../../../../src/http"
import ReplyGenerationRegistry, {
  type ReplyTarget
} from "../../../../../src/modules/chat/chat/replyGenerationRegistry"
import updateFastifyWithChatReplyRoutes from "../../../../../src/modules/chat/chat/replyRoutes"
import { parseSseEvents } from "../../../support/chatSseRoute"
import ControlledReplyTask from "../../../support/controlledReplyTask"
import {
  createAssistantMessage,
  createFixtureUuidV7,
  createUserMessage,
  FIXTURE_TIMESTAMP
} from "../../../support/conversationFixtures"
import { createTestFastify } from "../../../support/fastifyTestApp"
import { flushMicrotasks } from "../../../support/microtasks"

/** Conversation the stubbed history answers for. */
const CONVERSATION_ID = createFixtureUuidV7(1)

/** Stored user message of {@link CONVERSATION}. */
const USER_MESSAGE = createUserMessage(2, "Plan my trip")

/** Stored reply of {@link CONVERSATION} that the routes address. */
const ASSISTANT_MESSAGE = createAssistantMessage(3, "Here is", {
  status: "streaming"
})

/** Address of {@link ASSISTANT_MESSAGE} in its conversation. */
const REPLY_TARGET = Object.freeze({
  conversationId: CONVERSATION_ID,
  assistantMessageId: ASSISTANT_MESSAGE.id
} satisfies ReplyTarget)

/** Titled conversation holding {@link ASSISTANT_MESSAGE}. */
const CONVERSATION = Object.freeze({
  id: CONVERSATION_ID,
  title: "Trip plan",
  systemPrompt: "You are Lys.",
  createdAt: FIXTURE_TIMESTAMP,
  updatedAt: FIXTURE_TIMESTAMP,
  messages: [USER_MESSAGE, ASSISTANT_MESSAGE]
} satisfies Conversation)

/** Snapshot event opening every stream that follows {@link REPLY_TARGET}. */
const REPLY_SNAPSHOT_EVENT = Object.freeze({
  type: "reply-snapshot",
  conversationTitle: "Trip plan",
  assistantMessage: ASSISTANT_MESSAGE
})

/** Generation running for one reply, with both of its controlled tasks. */
type ControlledGeneration = Readonly<{
  /** Reply task; its signal is aborted by a stop or by disposal. */
  replyTask: ControlledReplyTask
  /** Title task; its signal is aborted only by disposal. */
  titleTask: ControlledReplyTask
  /** Records each task rejection the generation reports. */
  reportTaskFailure: Mock<(error: unknown) => void>
}>

/**
 * Fails a history call that the current case did not arrange.
 *
 * @param operationName - History operation that was called.
 * @throws Always.
 */
function rejectUnexpectedHistoryCall(operationName: string): never {
  throw new Error(`Unexpected conversation history call: ${operationName}`)
}

/**
 * Creates an application with the HTTP transport and the reply routes
 * registered over a stubbed history access and a real registry.
 *
 * @returns The application, captured logs, the registry, and a spy for the
 * history read the routes perform.
 * @remarks The routes borrow the history access once at registration, so the
 * returned spy controls every snapshot; it throws until the case configures
 * it and no database row is read. When the test finishes, the registry is
 * disposed first, then the in-memory store, then the application.
 */
async function createReplyRouteApp() {
  const testFastify = createTestFastify()
  const store = SqliteConversationStore.open(":memory:")
  onTestFinished(() => {
    store[Symbol.dispose]()
  })
  const generations = new ReplyGenerationRegistry()
  onTestFinished(async () => {
    await generations[Symbol.asyncDispose]()
  })
  const history = store.createHistoryAccess()
  vi.spyOn(store, "createHistoryAccess").mockReturnValue(history)
  const getConversation = vi
    .spyOn(history, "getConversation")
    .mockImplementation(() => rejectUnexpectedHistoryCall("getConversation"))
  await updateFastifyWithHttpTransport(testFastify.app)
  testFastify.app.decorate("conversationService", store)
  await updateFastifyWithChatReplyRoutes(testFastify.app, generations)
  return { ...testFastify, generations, getConversation }
}

/**
 * Starts a generation for one reply whose reply and title tasks stay pending
 * until the case settles them.
 *
 * @param generations - Registry that admits the generation.
 * @param target - Reply the generation writes, with its conversation.
 * @returns Both controlled tasks and the failure reporter.
 * @remarks Both tasks are settled when the test finishes, before the registry
 * is disposed, so a case that fails early does not leave disposal waiting.
 */
function startControlledGeneration(
  generations: ReplyGenerationRegistry,
  target: ReplyTarget
): ControlledGeneration {
  const replyTask = new ControlledReplyTask()
  const titleTask = new ControlledReplyTask()
  const reportTaskFailure = vi.fn<(error: unknown) => void>()
  generations.startReplyGeneration(target, {
    startReplyTask: replyTask.start,
    startTitleTask: titleTask.start,
    reportTaskFailure
  })
  onTestFinished(() => {
    replyTask.resolve()
    titleTask.resolve()
  })
  return { replyTask, titleTask, reportTaskFailure }
}

/**
 * Fills a reply route path with raw identifiers.
 *
 * @param path - Protocol path with `:conversationId` and `:assistantMessageId`.
 * @param conversationId - Raw conversation identifier, possibly malformed.
 * @param assistantMessageId - Raw reply identifier, possibly malformed.
 * @returns The request URL.
 */
function createReplyUrl(
  path: string,
  conversationId: string,
  assistantMessageId: string
): string {
  return path
    .replace(":conversationId", conversationId)
    .replace(":assistantMessageId", assistantMessageId)
}

/** URL of the reply-events endpoint for {@link REPLY_TARGET}. */
const REPLY_EVENTS_URL = createReplyUrl(
  chatReplyEventsApi.path,
  REPLY_TARGET.conversationId,
  REPLY_TARGET.assistantMessageId
)

/** URL of the reply-stop endpoint for {@link REPLY_TARGET}. */
const STOP_REPLY_URL = createReplyUrl(
  stopChatReplyApi.path,
  REPLY_TARGET.conversationId,
  REPLY_TARGET.assistantMessageId
)

/**
 * Creates a promise that settles when a signal aborts.
 *
 * @param signal - Signal observed from now on; it must not be aborted yet.
 * @returns Settlement inside the signal's abort dispatch.
 */
async function waitForAbort(signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    signal.addEventListener(
      "abort",
      () => {
        resolve()
      },
      { once: true }
    )
  })
}

describe("updateFastifyWithChatReplyRoutes", () => {
  describe("GET reply events", () => {
    it("responds with the missing-conversation problem before any stream starts", async () => {
      const { app, getConversation } = await createReplyRouteApp()
      getConversation.mockReturnValue(undefined)

      const response = await app.inject({
        method: "GET",
        url: REPLY_EVENTS_URL
      })

      expect(response.statusCode).toBe(404)
      expect(response.headers["content-type"]).toMatch(
        /^application\/problem\+json/
      )
      const problem: unknown = response.json()
      expect(conversationNotFoundProblemSchema.safeParse(problem).success).toBe(
        true
      )
      expect(problem).toEqual({
        type: "urn:lys:problem:conversation:not-found",
        title: "Conversation not found",
        status: 404,
        detail: `Conversation ${CONVERSATION_ID} was not found.`,
        instance: REPLY_EVENTS_URL
      })
      expect(getConversation).toHaveBeenCalledExactlyOnceWith(CONVERSATION_ID)
    })

    it.each([
      ["an unknown message identifier", createFixtureUuidV7(404)],
      ["the identifier of a user message", USER_MESSAGE.id]
    ])(
      "responds with the missing-reply problem for %s",
      async (_label, assistantMessageId) => {
        const { app, getConversation } = await createReplyRouteApp()
        getConversation.mockReturnValue(CONVERSATION)
        const url = createReplyUrl(
          chatReplyEventsApi.path,
          CONVERSATION_ID,
          assistantMessageId
        )

        const response = await app.inject({ method: "GET", url })

        expect(response.statusCode).toBe(404)
        expect(response.headers["content-type"]).toMatch(
          /^application\/problem\+json/
        )
        const problem: unknown = response.json()
        expect(chatReplyNotFoundProblemSchema.safeParse(problem).success).toBe(
          true
        )
        expect(problem).toEqual({
          type: "urn:lys:problem:chat:reply-not-found",
          title: "Reply not found",
          status: 404,
          detail: `Reply ${assistantMessageId} was not found.`,
          instance: url
        })
      }
    )

    it("responds with a server error before any stream starts when the conversation cannot be read", async () => {
      const { app, getConversation, logs } = await createReplyRouteApp()
      getConversation.mockImplementation(() => {
        throw new Error("database is locked")
      })

      const response = await app.inject({
        method: "GET",
        url: REPLY_EVENTS_URL
      })

      expect(response.statusCode).toBe(500)
      expect(response.headers["content-type"]).toMatch(/^application\/json/)
      expect(logs).toContainEqual(
        expect.objectContaining({
          level: "error",
          err: expect.objectContaining({ message: "database is locked" })
        })
      )
    })

    it("sends only the stored snapshot and ends when no generation is running", async () => {
      const { app, getConversation } = await createReplyRouteApp()
      getConversation.mockReturnValue(CONVERSATION)

      const response = await app.inject({
        method: "GET",
        url: REPLY_EVENTS_URL
      })

      expect(response.statusCode).toBe(200)
      expect(response.headers["content-type"]).toBe("text/event-stream")
      const events = parseSseEvents(response.body)
      expect(events).toEqual([
        { event: "reply-snapshot", data: REPLY_SNAPSHOT_EVENT }
      ])
      expect(chatReplyEventSchema.safeParse(events[0]?.data).success).toBe(true)
    })

    it("sends the snapshot, then the running generation's events, and ends when the generation settles", async () => {
      const { app, generations, getConversation } = await createReplyRouteApp()
      const generation = startControlledGeneration(generations, REPLY_TARGET)
      const snapshotRead = Promise.withResolvers<void>()
      getConversation.mockImplementation(() => {
        snapshotRead.resolve()
        return CONVERSATION
      })

      const responsePromise = app.inject({
        method: "GET",
        url: REPLY_EVENTS_URL
      })
      // The route reads the snapshot and registers its follower in one
      // synchronous step, so the follower exists once this read is observed.
      await snapshotRead.promise
      generation.replyTask.context.sendEvent({ type: "delta", content: " a" })
      generation.replyTask.context.sendEvent({
        type: "done",
        finishReason: "stop"
      })
      generation.replyTask.resolve()
      generation.titleTask.context.sendEvent({ type: "title", title: "Trips" })
      generation.titleTask.resolve()
      const response = await responsePromise

      expect(response.statusCode).toBe(200)
      const events = parseSseEvents(response.body)
      expect(events).toEqual([
        { event: "reply-snapshot", data: REPLY_SNAPSHOT_EVENT },
        { event: "delta", data: { type: "delta", content: " a" } },
        { event: "done", data: { type: "done", finishReason: "stop" } },
        { event: "title", data: { type: "title", title: "Trips" } }
      ])
      for (const { data } of events) {
        expect(chatReplyEventSchema.safeParse(data).success).toBe(true)
      }
      expect(generation.reportTaskFailure).not.toHaveBeenCalled()
    })

    it("does not follow a generation running for the same reply identifier in another conversation", async () => {
      const { app, generations, getConversation } = await createReplyRouteApp()
      const otherConversationGeneration = startControlledGeneration(
        generations,
        {
          conversationId: createFixtureUuidV7(99),
          assistantMessageId: REPLY_TARGET.assistantMessageId
        }
      )
      getConversation.mockReturnValue(CONVERSATION)

      const response = await app.inject({
        method: "GET",
        url: REPLY_EVENTS_URL
      })

      expect(parseSseEvents(response.body)).toEqual([
        { event: "reply-snapshot", data: REPLY_SNAPSHOT_EVENT }
      ])
      expect(otherConversationGeneration.replyTask.hasStarted).toBe(true)
      expect(
        otherConversationGeneration.replyTask.context.abortSignal.aborted
      ).toBe(false)
    })
  })

  describe("POST stop reply", () => {
    it("responds with the not-generating problem when no generation is running", async () => {
      const { app } = await createReplyRouteApp()

      const response = await app.inject({
        method: "POST",
        url: STOP_REPLY_URL
      })

      expect(response.statusCode).toBe(409)
      expect(response.headers["content-type"]).toMatch(
        /^application\/problem\+json/
      )
      const problem: unknown = response.json()
      expect(
        chatReplyNotGeneratingProblemSchema.safeParse(problem).success
      ).toBe(true)
      expect(problem).toEqual({
        type: "urn:lys:problem:chat:reply-not-generating",
        title: "Reply not generating",
        status: 409,
        detail: `Reply ${REPLY_TARGET.assistantMessageId} is not generating.`,
        instance: STOP_REPLY_URL
      })
    })

    it("does not stop a generation running for the same reply identifier in another conversation", async () => {
      const { app, generations } = await createReplyRouteApp()
      const otherConversationGeneration = startControlledGeneration(
        generations,
        {
          conversationId: createFixtureUuidV7(99),
          assistantMessageId: REPLY_TARGET.assistantMessageId
        }
      )

      const response = await app.inject({
        method: "POST",
        url: STOP_REPLY_URL
      })

      expect(response.statusCode).toBe(409)
      expect(
        chatReplyNotGeneratingProblemSchema.safeParse(response.json()).success
      ).toBe(true)
      expect(
        otherConversationGeneration.replyTask.context.abortSignal.aborted
      ).toBe(false)
    })

    it("cancels only the reply task and answers 204 after that task settled", async () => {
      const { app, generations } = await createReplyRouteApp()
      const generation = startControlledGeneration(generations, REPLY_TARGET)
      await flushMicrotasks()
      const replyAborted = waitForAbort(
        generation.replyTask.context.abortSignal
      )
      const sentStatusCodes: number[] = []
      app.addHook("onSend", async (_request, reply) => {
        sentStatusCodes.push(reply.statusCode)
      })

      const responsePromise = app.inject({
        method: "POST",
        url: STOP_REPLY_URL
      })
      await replyAborted
      await flushMicrotasks()

      expect(generation.titleTask.context.abortSignal.aborted).toBe(false)
      expect(sentStatusCodes).toEqual([])
      generation.replyTask.resolve()
      const response = await responsePromise
      expect(response.statusCode).toBe(204)
      expect(response.body).toBe("")
      expect(sentStatusCodes).toEqual([204])
    })

    it("answers 204 when the reply already ended while the turn's title task still runs", async () => {
      const { app, generations } = await createReplyRouteApp()
      const generation = startControlledGeneration(generations, REPLY_TARGET)
      generation.replyTask.resolve()

      const response = await app.inject({
        method: "POST",
        url: STOP_REPLY_URL
      })

      expect(response.statusCode).toBe(204)
      expect(response.body).toBe("")
      expect(generation.titleTask.context.abortSignal.aborted).toBe(false)
    })
  })

  describe.each([
    ["GET", chatReplyEventsApi.path],
    ["POST", stopChatReplyApi.path]
  ] as const)("%s %s", (method, path) => {
    it.each([
      ["a conversation identifier that is not a UUID", "conversation-1", null],
      [
        "a reply identifier that is a UUIDv4",
        null,
        "0b0e9f3e-5a4c-4f7e-9d4a-2c1b3a4d5e6f"
      ]
    ])(
      "rejects %s before reading history or stopping a reply",
      async (_label, conversationId, assistantMessageId) => {
        const { app, generations, getConversation } =
          await createReplyRouteApp()
        const generation = startControlledGeneration(generations, REPLY_TARGET)
        const url = createReplyUrl(
          path,
          conversationId ?? REPLY_TARGET.conversationId,
          assistantMessageId ?? REPLY_TARGET.assistantMessageId
        )

        const response = await app.inject({ method, url })

        expect(response.statusCode).toBe(400)
        expect(getConversation).not.toHaveBeenCalled()
        expect(generation.replyTask.context.abortSignal.aborted).toBe(false)
      }
    )

    it("fails with a server error once the registry is closed for shutdown", async () => {
      const { app, generations, getConversation, logs } =
        await createReplyRouteApp()
      getConversation.mockReturnValue(CONVERSATION)
      await generations[Symbol.asyncDispose]()

      const response = await app.inject({
        method,
        url: createReplyUrl(
          path,
          REPLY_TARGET.conversationId,
          REPLY_TARGET.assistantMessageId
        )
      })

      expect(response.statusCode).toBe(500)
      expect(response.headers["content-type"]).toMatch(/^application\/json/)
      expect(logs).toContainEqual(
        expect.objectContaining({
          level: "error",
          err: expect.objectContaining({
            message: "Reply generation registry is closed"
          })
        })
      )
    })
  })
})
