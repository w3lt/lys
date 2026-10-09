import {
  chatReplyEventSchema,
  chatReplyEventsApi,
  chatReplyNotFoundProblemSchema,
  chatReplyNotGeneratingProblemSchema,
  chatToolCallNotPendingProblemSchema,
  conversationNotFoundProblemSchema,
  MAXIMUM_TOOL_RESULT_BODY_BYTES,
  sendChatToolResultApi,
  stopChatReplyApi,
  type ChatToolCall,
  type ChatToolResult
} from "@lys/protocol"
import type { Conversation } from "@lys/share"
import type { FastifyInstance } from "fastify"
import { describe, expect, it, onTestFinished, vi, type Mock } from "vitest"
import { updateFastifyWithHttpTransport } from "../../../../../src/http"
import type { ReplyTaskContext } from "../../../../../src/modules/chat/replyGeneration"
import ReplyGenerationRegistry, {
  type ReplyTarget
} from "../../../../../src/modules/chat/replyGenerationRegistry"
import updateFastifyWithChatReplyRoutes from "../../../../../src/modules/chat/routes/replyRoutes"
import { parseSseEvents } from "../../../support/chatSseRoute"
import ControlledReplyTask from "../../../support/controlledReplyTask"
import {
  createAssistantMessage,
  createFixtureUuidV7,
  createUserMessage,
  FIXTURE_TIMESTAMP
} from "../../../support/conversationFixtures"
import { openConversationTestServices } from "../../../support/conversationDatabase"
import { createTestFastify } from "../../../support/fastifyTestApp"
import { waitForMicrotasks } from "../../../support/microtasks"

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
  agentCode: "lys",
  createdAt: FIXTURE_TIMESTAMP,
  updatedAt: FIXTURE_TIMESTAMP,
  messages: [USER_MESSAGE, ASSISTANT_MESSAGE]
} satisfies Conversation)

/** Snapshot event opening every stream that follows {@link REPLY_TARGET}. */
const REPLY_SNAPSHOT_EVENT = Object.freeze({
  type: "reply-snapshot",
  conversationTitle: "Trip plan",
  assistantMessage: ASSISTANT_MESSAGE,
  pendingToolCalls: []
})

/** Generation running for one reply, with both of its controlled tasks. */
type ControlledGeneration = Readonly<{
  /** Reply task; its signal is aborted by a stop or by disposal. */
  replyTask: ControlledReplyTask<ReplyTaskContext>
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
function handleUnexpectedHistoryCall(operationName: string): never {
  throw new Error(`Unexpected conversation history call: ${operationName}`)
}

/**
 * Creates an application with the HTTP transport and the reply routes
 * registered over a stubbed history reader and a real registry.
 *
 * @returns The application, captured logs, the registry, and a spy for the
 * history read the routes perform.
 * @remarks The routes read the decorated history reader at registration, so
 * the returned spy controls every snapshot; it throws until the case
 * configures it and no database row is read. When the test finishes, the
 * registry is disposed first, then the in-memory conversation database, then
 * the application.
 */
async function createReplyRouteApp() {
  const testFastify = createTestFastify()
  const { history } = openConversationTestServices()
  const generations = new ReplyGenerationRegistry()
  onTestFinished(async () => {
    await generations[Symbol.asyncDispose]()
  })
  const getConversation = vi
    .spyOn(history, "getConversation")
    .mockImplementation(() => handleUnexpectedHistoryCall("getConversation"))
  await updateFastifyWithHttpTransport(testFastify.app)
  testFastify.app.decorate("conversationHistoryReader", history)
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
  const replyTask = new ControlledReplyTask<ReplyTaskContext>()
  const titleTask = new ControlledReplyTask()
  const reportTaskFailure = vi.fn<(error: unknown) => void>()
  generations.startReplyGeneration(target, {
    startReplyTask: (context) => replyTask.start(context),
    startTitleTask: (context) => titleTask.start(context),
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

/** Call the controlled reply waits on. */
const TOOL_CALL = Object.freeze({
  id: createFixtureUuidV7(10),
  toolName: "read_text_file",
  arguments: Object.freeze({ path: "/notes/todo.md" })
} satisfies ChatToolCall)

/** Answer a client gives to {@link TOOL_CALL}. */
const SUCCEEDED_RESULT = Object.freeze({
  status: "succeeded",
  content: "Buy milk"
} satisfies ChatToolResult)

/**
 * Builds the tool-result URL of one call of {@link REPLY_TARGET}.
 *
 * @param callId - Raw call identifier, possibly malformed.
 * @returns The request URL.
 */
function createToolResultUrl(callId: string): string {
  return createReplyUrl(
    sendChatToolResultApi.path,
    REPLY_TARGET.conversationId,
    REPLY_TARGET.assistantMessageId
  ).replace(":callId", callId)
}

/**
 * Sends one tool result for {@link REPLY_TARGET}.
 *
 * @param app - Application with the reply routes registered.
 * @param callId - Raw call identifier.
 * @param payload - Raw request body, serialized as JSON.
 * @returns The completed response.
 */
async function sendToolResult(
  app: FastifyInstance,
  callId: string,
  payload: unknown
) {
  return await app.inject({
    method: "POST",
    url: createToolResultUrl(callId),
    headers: { "content-type": "application/json" },
    payload: JSON.stringify(payload)
  })
}

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
        detail: expect.any(String),
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
          detail: expect.any(String),
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

  describe("GET reply events with tool calls", () => {
    it("lists a call the reply waits on in the snapshot and does not send it again", async () => {
      const { app, generations, getConversation } = await createReplyRouteApp()
      const generation = startControlledGeneration(generations, REPLY_TARGET)
      await waitForMicrotasks()
      void generation.replyTask.context.sendToolCall(TOOL_CALL)
      const snapshotRead = Promise.withResolvers<void>()
      getConversation.mockImplementation(() => {
        snapshotRead.resolve()
        return CONVERSATION
      })

      const responsePromise = app.inject({
        method: "GET",
        url: REPLY_EVENTS_URL
      })
      // The generation must still run when the route reads its snapshot.
      await snapshotRead.promise
      generation.replyTask.resolve()
      generation.titleTask.resolve()
      const response = await responsePromise

      expect(parseSseEvents(response.body)).toEqual([
        {
          event: "reply-snapshot",
          data: { ...REPLY_SNAPSHOT_EVENT, pendingToolCalls: [TOOL_CALL] }
        }
      ])
    })

    it("sends a call made after following began as a tool-call event", async () => {
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
      await snapshotRead.promise
      void generation.replyTask.context.sendToolCall(TOOL_CALL)
      generation.replyTask.resolve()
      generation.titleTask.resolve()
      const response = await responsePromise

      expect(parseSseEvents(response.body)).toEqual([
        { event: "reply-snapshot", data: REPLY_SNAPSHOT_EVENT },
        { event: "tool-call", data: { type: "tool-call", call: TOOL_CALL } }
      ])
    })
  })

  describe("POST tool result", () => {
    it("answers 204 and resumes the reply with the answer", async () => {
      const { app, generations } = await createReplyRouteApp()
      const generation = startControlledGeneration(generations, REPLY_TARGET)
      await waitForMicrotasks()
      const answer = generation.replyTask.context.sendToolCall(TOOL_CALL)

      const response = await sendToolResult(app, TOOL_CALL.id, SUCCEEDED_RESULT)

      expect(response.statusCode).toBe(204)
      expect(response.body).toBe("")
      expect(await answer).toEqual(SUCCEEDED_RESULT)
    })

    it("answers 409 to a second answer for the same call", async () => {
      const { app, generations } = await createReplyRouteApp()
      const generation = startControlledGeneration(generations, REPLY_TARGET)
      await waitForMicrotasks()
      void generation.replyTask.context.sendToolCall(TOOL_CALL)
      await sendToolResult(app, TOOL_CALL.id, SUCCEEDED_RESULT)

      const response = await sendToolResult(app, TOOL_CALL.id, SUCCEEDED_RESULT)

      expect(response.statusCode).toBe(409)
      expect(response.headers["content-type"]).toMatch(
        /^application\/problem\+json/
      )
      const problem: unknown = response.json()
      expect(
        chatToolCallNotPendingProblemSchema.safeParse(problem).success
      ).toBe(true)
      expect(problem).toMatchObject({
        instance: createToolResultUrl(TOOL_CALL.id)
      })
    })

    it.each([
      ["no generation runs for the reply", false, TOOL_CALL.id],
      [
        "the reply waits on no call with that identifier",
        true,
        createFixtureUuidV7(404)
      ]
    ])("answers 409 when %s", async (_label, isGenerating, callId) => {
      const { app, generations } = await createReplyRouteApp()
      if (isGenerating) startControlledGeneration(generations, REPLY_TARGET)

      const response = await sendToolResult(app, callId, SUCCEEDED_RESULT)

      expect(response.statusCode).toBe(409)
    })

    it("answers 409 once the reply was stopped while the call waited", async () => {
      const { app, generations } = await createReplyRouteApp()
      const generation = startControlledGeneration(generations, REPLY_TARGET)
      await waitForMicrotasks()
      const answer = generation.replyTask.context.sendToolCall(TOOL_CALL)
      const stop = app.inject({ method: "POST", url: STOP_REPLY_URL })
      await waitForAbort(generation.replyTask.context.abortSignal)

      const response = await sendToolResult(app, TOOL_CALL.id, SUCCEEDED_RESULT)

      expect(response.statusCode).toBe(409)
      expect(await answer).toBeUndefined()
      generation.replyTask.resolve()
      expect((await stop).statusCode).toBe(204)
    })

    it.each([
      [
        "a failed answer without content",
        { status: "failed", reason: "declined", content: "" }
      ],
      ["an unknown status", { status: "skipped", content: "x" }]
    ])(
      "rejects %s with 400 and leaves the call waiting",
      async (_label, payload) => {
        const { app, generations } = await createReplyRouteApp()
        const generation = startControlledGeneration(generations, REPLY_TARGET)
        await waitForMicrotasks()
        void generation.replyTask.context.sendToolCall(TOOL_CALL)

        const response = await sendToolResult(app, TOOL_CALL.id, payload)

        expect(response.statusCode).toBe(400)
        expect(
          generations.findReplyGeneration(REPLY_TARGET)?.pendingToolCalls
        ).toEqual([TOOL_CALL])
      }
    )

    it("accepts an answer larger than the default body limit of other routes", async () => {
      const { app, generations } = await createReplyRouteApp()
      const generation = startControlledGeneration(generations, REPLY_TARGET)
      await waitForMicrotasks()
      const answer = generation.replyTask.context.sendToolCall(TOOL_CALL)
      const content = "x".repeat(2 * 1024 * 1024)

      const response = await sendToolResult(app, TOOL_CALL.id, {
        status: "succeeded",
        content
      })

      expect(response.statusCode).toBe(204)
      expect(await answer).toEqual({ status: "succeeded", content })
    })

    it("rejects an answer larger than the body limit with 413 and leaves the call waiting", async () => {
      const { app, generations } = await createReplyRouteApp()
      const generation = startControlledGeneration(generations, REPLY_TARGET)
      await waitForMicrotasks()
      void generation.replyTask.context.sendToolCall(TOOL_CALL)

      const response = await sendToolResult(app, TOOL_CALL.id, {
        status: "succeeded",
        content: "x".repeat(MAXIMUM_TOOL_RESULT_BODY_BYTES)
      })

      expect(response.statusCode).toBe(413)
      expect(
        generations.findReplyGeneration(REPLY_TARGET)?.pendingToolCalls
      ).toEqual([TOOL_CALL])
    })

    it.each([
      [
        "a conversation identifier that is not a UUID",
        "conversation-1",
        REPLY_TARGET.assistantMessageId,
        TOOL_CALL.id
      ],
      [
        "a reply identifier that is a UUIDv4",
        REPLY_TARGET.conversationId,
        "0b0e9f3e-5a4c-4f7e-9d4a-2c1b3a4d5e6f",
        TOOL_CALL.id
      ],
      [
        "a call identifier the model wrote",
        REPLY_TARGET.conversationId,
        REPLY_TARGET.assistantMessageId,
        "call_0"
      ]
    ])(
      "rejects %s with 400 and leaves the call waiting",
      async (_label, conversationId, assistantMessageId, callId) => {
        const { app, generations } = await createReplyRouteApp()
        const generation = startControlledGeneration(generations, REPLY_TARGET)
        await waitForMicrotasks()
        void generation.replyTask.context.sendToolCall(TOOL_CALL)
        const url = createReplyUrl(
          sendChatToolResultApi.path,
          conversationId,
          assistantMessageId
        ).replace(":callId", callId)

        const response = await app.inject({
          method: "POST",
          url,
          headers: { "content-type": "application/json" },
          payload: JSON.stringify(SUCCEEDED_RESULT)
        })

        expect(response.statusCode).toBe(400)
        expect(
          generations.findReplyGeneration(REPLY_TARGET)?.pendingToolCalls
        ).toEqual([TOOL_CALL])
      }
    )

    it("fails with a server error once the registry is closed for shutdown", async () => {
      const { app, generations, logs } = await createReplyRouteApp()
      await generations[Symbol.asyncDispose]()

      const response = await sendToolResult(app, TOOL_CALL.id, SUCCEEDED_RESULT)

      expect(response.statusCode).toBe(500)
      expect(response.headers["content-type"]).toMatch(/^application\/json/)
      expect(logs).toContainEqual(
        expect.objectContaining({ level: "error", err: expect.any(Object) })
      )
    })

    it("logs why the client could not answer, at debug level", async () => {
      const { app, generations, logs } = await createReplyRouteApp()
      const generation = startControlledGeneration(generations, REPLY_TARGET)
      await waitForMicrotasks()
      void generation.replyTask.context.sendToolCall(TOOL_CALL)

      await sendToolResult(app, TOOL_CALL.id, {
        status: "failed",
        reason: "declined",
        content: "The person declined this call."
      })

      expect(logs).toContainEqual(
        expect.objectContaining({
          level: "debug",
          toolCallId: TOOL_CALL.id,
          reason: "declined"
        })
      )
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
        detail: expect.any(String),
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
      await waitForMicrotasks()
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
      await waitForMicrotasks()

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
        expect.objectContaining({ level: "error", err: expect.any(Object) })
      )
    })
  })
})
