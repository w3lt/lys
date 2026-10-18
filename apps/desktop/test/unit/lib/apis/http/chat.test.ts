import {
  chatApiRequestBodySchema,
  chatBackendToolUnavailableProblemSchema,
  chatToolApprovalAnswerSchema,
  chatToolCallNotPendingProblemSchema,
  chatToolResultSchema,
  conversationAgentMissingProblemSchema,
  createLlmServiceBusyProblem,
  type BackendToolUnavailableReason
} from "@lys/protocol"
import { CALIGINIA_AGENT_CODE } from "@lys/share"
import { describe, expect, it } from "vitest"
import {
  BackendToolUnavailableError,
  getChatContextMeasurement,
  readChatEvents,
  readChatReplyEvents,
  sendChatToolApproval,
  sendChatToolResult,
  stopChatReply
} from "@/lib/apis/http/chat"
import { DELETED_CONVERSATION_AGENT_MESSAGE } from "@/lib/conversation-agent-messages"
import {
  buildJsonResponse,
  createTransportFailure,
  FIXTURE_BACKEND_URL,
  startBackendEventStream,
  startBackendFake,
  type BackendEventStream
} from "../../../support/backendFake"
import {
  buildStreamingAssistantMessage,
  buildConversationMetadata,
  buildConversationNotFoundProblem,
  buildReplyNotFoundProblem,
  buildReplyNotGeneratingProblem,
  buildUserMessage,
  createFixtureUuidV7,
  FIXTURE_CONVERSATION_ID
} from "../../../support/conversationFixtures"
import {
  CHAT_CONTEXT_ROUTE,
  FIXTURE_CHAT_CONTEXT_MEASUREMENT
} from "../../../support/chatContextFixtures"
import {
  buildToolCall,
  buildToolDefinition
} from "../../../support/toolFixtures"

/** Reply the reply cases follow or stop. */
const REPLY_TARGET = Object.freeze({
  conversationId: FIXTURE_CONVERSATION_ID,
  assistantMessageId: createFixtureUuidV7(3)
})

/** Route key of the reply-events endpoint for {@link REPLY_TARGET}. */
const REPLY_EVENTS_ROUTE = `GET /api/v1/chat/${REPLY_TARGET.conversationId}/replies/${REPLY_TARGET.assistantMessageId}/events`

/** Route key of the reply-stop endpoint for {@link REPLY_TARGET}. */
const REPLY_STOP_ROUTE = `POST /api/v1/chat/${REPLY_TARGET.conversationId}/replies/${REPLY_TARGET.assistantMessageId}/stop`

/** Route key of the chat endpoint. */
const CHAT_ROUTE = "POST /api/v1/chat"

/** Request that starts a new conversation Caliginia answers, without tools. */
const NEW_CONVERSATION_REQUEST = Object.freeze(
  chatApiRequestBodySchema.parse({
    conversation: { kind: "new", agentCode: CALIGINIA_AGENT_CODE },
    message: "Hello",
    model: "qwen3-8b",
    generationOptions: { temperature: 0.7 }
  })
)

/** Request that continues the fixture conversation and offers one tool. */
const CONTINUED_CONVERSATION_REQUEST = Object.freeze(
  chatApiRequestBodySchema.parse({
    conversation: { kind: "existing", id: FIXTURE_CONVERSATION_ID },
    message: "Read my notes",
    model: "qwen3-8b",
    generationOptions: { temperature: 0.2, replyCeiling: 512 },
    tools: { definitions: [buildToolDefinition("read_text_file")] }
  })
)

/** Call the backend asks the desktop to answer while the reply runs. */
const TOOL_CALL = buildToolCall(4, "read_text_file")

/** One tool call of {@link REPLY_TARGET} that the tool-result cases answer. */
const TOOL_CALL_TARGET = Object.freeze({
  ...REPLY_TARGET,
  callId: TOOL_CALL.id
})

/** Route key of the tool-result endpoint for {@link TOOL_CALL_TARGET}. */
const TOOL_RESULT_ROUTE = `POST /api/v1/chat/${REPLY_TARGET.conversationId}/replies/${REPLY_TARGET.assistantMessageId}/tool-results/${TOOL_CALL.id}`

/** Route key of the tool-approval endpoint for {@link TOOL_CALL_TARGET}. */
const TOOL_APPROVAL_ROUTE = `POST /api/v1/chat/${REPLY_TARGET.conversationId}/replies/${REPLY_TARGET.assistantMessageId}/tool-approvals/${TOOL_CALL.id}`

/** Answer of a person who allowed a call. */
const ALLOWED_TOOL_APPROVAL = Object.freeze(
  chatToolApprovalAnswerSchema.parse({ status: "allowed" })
)

/** Answer of a tool that ran and returned its output. */
const SUCCEEDED_TOOL_RESULT = Object.freeze(
  chatToolResultSchema.parse({ status: "succeeded", content: "Buy milk." })
)

/** Problem the backend sends when a continued conversation's agent is gone. */
const CONVERSATION_AGENT_MISSING_PROBLEM =
  conversationAgentMissingProblemSchema.parse({
    type: "urn:lys:problem:conversation:agent-missing",
    title: "Conversation agent missing",
    status: 409,
    detail: "No agent has the code this conversation was started with."
  })

/**
 * Builds the problem the backend sends when an offered backend tool cannot
 * run now.
 *
 * @param toolName - Tool that cannot run.
 * @param reason - Why the tool cannot run.
 * @returns The problem, validated by the shared schema.
 */
function buildBackendToolUnavailableProblem(
  toolName: string,
  reason: BackendToolUnavailableReason
) {
  return chatBackendToolUnavailableProblemSchema.parse({
    type: "urn:lys:problem:chat:backend-tool-unavailable",
    title: "Backend tool unavailable",
    status: 409,
    detail: `The offered tool ${toolName} cannot run now.`,
    toolName,
    reason
  })
}

/** Problem the backend sends for an answer to a call that is not waiting. */
const TOOL_CALL_NOT_PENDING_PROBLEM = chatToolCallNotPendingProblemSchema.parse(
  {
    type: "urn:lys:problem:chat:tool-call-not-pending",
    title: "Tool call not pending",
    status: 409,
    detail: "No tool call is waiting under this identifier."
  }
)

/** Start event the backend sends for {@link NEW_CONVERSATION_REQUEST}. */
const NEW_CONVERSATION_START_EVENT = Object.freeze({
  type: "start-new-conversation-turn",
  conversation: buildConversationMetadata(FIXTURE_CONVERSATION_ID, null),
  userMessage: buildUserMessage(2, "Hello"),
  assistantMessage: buildStreamingAssistantMessage(3, "")
})

/**
 * Reads every event a stream yields until it completes or fails.
 *
 * @param events - Event stream under test.
 * @returns The events in arrival order.
 */
async function listStreamEvents<TEvent>(
  events: AsyncIterable<TEvent>
): Promise<TEvent[]> {
  const received: TEvent[] = []
  for await (const event of events) received.push(event)
  return received
}

/**
 * Reads one event and then stops reading, as a consumer that leaves early.
 *
 * @param events - Event stream under test.
 * @returns The first event, after the stream was ended from the reader side.
 */
async function readFirstStreamEvent<TEvent>(
  events: AsyncGenerator<TEvent, void, unknown>
): Promise<TEvent | void> {
  const first = await events.next()
  await events.return()
  return first.value
}

/**
 * Sends events and ends the stream.
 *
 * @param stream - Stream the backend writes.
 * @param events - Event payloads in sending order.
 */
function sendStreamEvents(
  stream: BackendEventStream,
  events: readonly unknown[]
): void {
  events.forEach((event) => stream.sendEvent(event))
  stream.close()
}

describe("readChatEvents", () => {
  it.each([
    ["a new conversation's request", NEW_CONVERSATION_REQUEST],
    [
      "a continued conversation's request that offers tools",
      CONTINUED_CONVERSATION_REQUEST
    ]
  ])(
    "posts %s to the local backend's chat endpoint",
    async (_label, request) => {
      const stream = startBackendEventStream()
      const backend = startBackendFake({ [CHAT_ROUTE]: () => stream.response })
      const signal = new AbortController().signal
      stream.close()

      await listStreamEvents(readChatEvents(request, { signal }))

      expect(backend.requests).toHaveLength(1)
      expect(backend.requests[0]?.url).toBe(
        "http://127.0.0.1:12345/api/v1/chat"
      )
      expect(backend.requests[0]?.body).toEqual(request)
      expect(backend.requests[0]?.headers.get("Content-Type")).toBe(
        "application/json"
      )
      expect(backend.requests[0]?.headers.get("Accept")).toBe(
        "text/event-stream"
      )
      expect(backend.requests[0]?.signal).toBe(signal)
    }
  )

  it("yields each event in order, tool calls included, until the backend ends the stream", async () => {
    const stream = startBackendEventStream()
    startBackendFake({ [CHAT_ROUTE]: () => stream.response })
    const events = [
      NEW_CONVERSATION_START_EVENT,
      { type: "delta", content: "Let me look." },
      { type: "tool-call", call: TOOL_CALL },
      { type: "delta", content: "\n\nHi" },
      { type: "title", title: "Greeting" },
      { type: "done", finishReason: "stop" }
    ]
    sendStreamEvents(stream, events)

    await expect(
      listStreamEvents(readChatEvents(NEW_CONVERSATION_REQUEST))
    ).resolves.toEqual(events)
  })

  it("rejects a failed request before yielding events", async () => {
    startBackendFake({
      [CHAT_ROUTE]: () => buildJsonResponse(500, { detail: "boom" })
    })

    await expect(
      listStreamEvents(readChatEvents(NEW_CONVERSATION_REQUEST))
    ).rejects.toThrow("500")
  })

  it("reports a continued conversation whose agent was deleted", async () => {
    startBackendFake({
      [CHAT_ROUTE]: () =>
        buildJsonResponse(409, CONVERSATION_AGENT_MISSING_PROBLEM)
    })

    await expect(
      listStreamEvents(readChatEvents(CONTINUED_CONVERSATION_REQUEST))
    ).rejects.toThrow(DELETED_CONVERSATION_AGENT_MESSAGE)
  })

  it.each([
    [
      "web_search",
      "api-key-missing",
      "web_search is unavailable: no Tavily API key is saved. Add one in Settings → Secrets, or switch web_search off."
    ],
    [
      "web_search",
      "api-key-invalid",
      "web_search is unavailable: the Tavily API key in settings.json isn't valid. Fix or remove secrets.tavilyApiKey in that file, or switch web_search off."
    ],
    [
      "web_search",
      "settings-unreadable",
      "web_search is unavailable: Lys couldn't read settings.json. Fix that file by hand, or switch web_search off."
    ],
    [
      "read_page",
      "page-reader-not-ready",
      "read_page is unavailable: vmo, Lys's page reader, isn't ready. Start it in Settings → Runtime, or switch read_page off."
    ]
  ] as const)(
    "reports %s that cannot run because of %s, with what to do",
    async (toolName, reason, message) => {
      startBackendFake({
        [CHAT_ROUTE]: () =>
          buildJsonResponse(
            409,
            buildBackendToolUnavailableProblem(toolName, reason)
          )
      })

      const failure = await listStreamEvents(
        readChatEvents(NEW_CONVERSATION_REQUEST)
      ).then(
        () => {
          throw new Error("The chat stream opened")
        },
        (rejection: unknown) => rejection
      )

      expect(failure).toBeInstanceOf(BackendToolUnavailableError)
      expect(failure).toMatchObject({ message })
    }
  )

  it("does not report an undeclared conflict as a deleted agent", async () => {
    startBackendFake({
      [CHAT_ROUTE]: () => buildJsonResponse(409, { message: "conflict" })
    })

    const events = listStreamEvents(
      readChatEvents(CONTINUED_CONVERSATION_REQUEST)
    )

    await expect(events).rejects.toThrow("409")
    await expect(events).rejects.not.toThrow(DELETED_CONVERSATION_AGENT_MESSAGE)
    await expect(events).rejects.not.toBeInstanceOf(BackendToolUnavailableError)
  })

  it.each([
    ["an empty delta", { type: "delta", content: "" }],
    [
      "a tool call whose identifier is not a UUIDv7",
      { type: "tool-call", call: { ...TOOL_CALL, id: "call-1" } }
    ]
  ])("rejects %s, which breaks the stream contract", async (_label, event) => {
    const stream = startBackendEventStream()
    startBackendFake({ [CHAT_ROUTE]: () => stream.response })
    sendStreamEvents(stream, [event])

    await expect(
      listStreamEvents(readChatEvents(NEW_CONVERSATION_REQUEST))
    ).rejects.toMatchObject({ name: "ZodError" })
  })

  it("rejects an event whose data is not JSON", async () => {
    const stream = startBackendEventStream()
    startBackendFake({ [CHAT_ROUTE]: () => stream.response })
    stream.sendText("data: {not json\n\n")
    stream.close()

    await expect(
      listStreamEvents(readChatEvents(NEW_CONVERSATION_REQUEST))
    ).rejects.toThrow(SyntaxError)
  })

  it("cancels the response body when the consumer stops reading early", async () => {
    const stream = startBackendEventStream()
    startBackendFake({ [CHAT_ROUTE]: () => stream.response })
    stream.sendEvent(NEW_CONVERSATION_START_EVENT)

    await expect(
      readFirstStreamEvent(readChatEvents(NEW_CONVERSATION_REQUEST))
    ).resolves.toEqual(NEW_CONVERSATION_START_EVENT)
    expect(stream.isCancelled()).toBe(true)
  })

  it("ends observation with the abort reason when the signal aborts mid-stream", async () => {
    const stream = startBackendEventStream()
    startBackendFake({ [CHAT_ROUTE]: () => stream.response })
    const controller = new AbortController()
    stream.sendEvent(NEW_CONVERSATION_START_EVENT)
    const events = readChatEvents(NEW_CONVERSATION_REQUEST, {
      signal: controller.signal
    })
    await events.next()

    controller.abort()

    await expect(events.next()).rejects.toMatchObject({ name: "AbortError" })
    expect(stream.isCancelled()).toBe(true)
  })
})

describe("readChatReplyEvents", () => {
  it("follows the reply at the caller's backend origin", async () => {
    const stream = startBackendEventStream()
    const backend = startBackendFake({
      [REPLY_EVENTS_ROUTE]: () => stream.response
    })
    const signal = new AbortController().signal
    stream.close()

    await listStreamEvents(
      readChatReplyEvents(REPLY_TARGET, {
        backendUrl: FIXTURE_BACKEND_URL,
        signal
      })
    )

    expect(backend.requests[0]?.url).toBe(
      `${FIXTURE_BACKEND_URL}/api/v1/chat/${REPLY_TARGET.conversationId}/replies/${REPLY_TARGET.assistantMessageId}/events`
    )
    expect(backend.requests[0]?.headers.get("Accept")).toBe("text/event-stream")
    expect(backend.requests[0]?.cache).toBe("no-store")
    expect(backend.requests[0]?.signal).toBe(signal)
  })

  it("yields the snapshot with its pending tool calls and prompts and the live events in order", async () => {
    const stream = startBackendEventStream()
    startBackendFake({ [REPLY_EVENTS_ROUTE]: () => stream.response })
    const events = [
      {
        type: "reply-snapshot",
        conversationTitle: null,
        assistantMessage: buildStreamingAssistantMessage(3, "Hi"),
        pendingToolCalls: [TOOL_CALL],
        pendingToolApprovals: [buildToolCall(6, "read_text_file")]
      },
      { type: "tool-approval", call: buildToolCall(7, "find_files") },
      { type: "tool-call", call: buildToolCall(5, "find_files") },
      { type: "delta", content: " there" },
      { type: "done", finishReason: "length" }
    ]
    sendStreamEvents(stream, events)

    await expect(
      listStreamEvents(
        readChatReplyEvents(REPLY_TARGET, { backendUrl: FIXTURE_BACKEND_URL })
      )
    ).resolves.toEqual(events)
  })

  it.each([
    ["conversation", buildConversationNotFoundProblem()],
    ["reply", buildReplyNotFoundProblem()]
  ])(
    "reports a %s the backend declares absent as no longer stored",
    async (_absent, problem) => {
      startBackendFake({
        [REPLY_EVENTS_ROUTE]: () => buildJsonResponse(404, problem)
      })

      await expect(
        listStreamEvents(
          readChatReplyEvents(REPLY_TARGET, { backendUrl: FIXTURE_BACKEND_URL })
        )
      ).rejects.toThrow("no longer stored")
    }
  )

  it("does not report an undeclared 404 as an absent reply", async () => {
    startBackendFake({
      [REPLY_EVENTS_ROUTE]: () =>
        buildJsonResponse(404, { message: "Route not found" })
    })

    const events = listStreamEvents(
      readChatReplyEvents(REPLY_TARGET, { backendUrl: FIXTURE_BACKEND_URL })
    )

    await expect(events).rejects.toThrow("404")
    await expect(events).rejects.not.toThrow("no longer stored")
  })

  it.each([
    ["a chat stream's start event", NEW_CONVERSATION_START_EVENT],
    [
      "a snapshot without its pending tool calls",
      {
        type: "reply-snapshot",
        conversationTitle: null,
        assistantMessage: buildStreamingAssistantMessage(3, "Hi")
      }
    ]
  ])(
    "rejects %s, which breaks the reply-event contract",
    async (_label, event) => {
      const stream = startBackendEventStream()
      startBackendFake({ [REPLY_EVENTS_ROUTE]: () => stream.response })
      sendStreamEvents(stream, [event])

      await expect(
        listStreamEvents(
          readChatReplyEvents(REPLY_TARGET, { backendUrl: FIXTURE_BACKEND_URL })
        )
      ).rejects.toMatchObject({ name: "ZodError" })
    }
  )

  it("cancels the response body when the consumer stops reading early", async () => {
    const stream = startBackendEventStream()
    startBackendFake({ [REPLY_EVENTS_ROUTE]: () => stream.response })
    stream.sendEvent({ type: "delta", content: "Hi" })

    await readFirstStreamEvent(
      readChatReplyEvents(REPLY_TARGET, { backendUrl: FIXTURE_BACKEND_URL })
    )

    expect(stream.isCancelled()).toBe(true)
  })
})

describe("stopChatReply", () => {
  it("reports stopped for the backend's acknowledgement, without a cancellation signal", async () => {
    const backend = startBackendFake({
      [REPLY_STOP_ROUTE]: () => new Response(null, { status: 204 })
    })

    await expect(
      stopChatReply(REPLY_TARGET, { backendUrl: FIXTURE_BACKEND_URL })
    ).resolves.toEqual({ status: "stopped" })
    expect(backend.requests[0]?.url).toBe(
      `${FIXTURE_BACKEND_URL}/api/v1/chat/${REPLY_TARGET.conversationId}/replies/${REPLY_TARGET.assistantMessageId}/stop`
    )
    expect(backend.requests[0]?.signal).toBeUndefined()
  })

  it("reports not generating for the declared conflict", async () => {
    startBackendFake({
      [REPLY_STOP_ROUTE]: () =>
        buildJsonResponse(409, buildReplyNotGeneratingProblem())
    })

    await expect(
      stopChatReply(REPLY_TARGET, { backendUrl: FIXTURE_BACKEND_URL })
    ).resolves.toEqual({ status: "not-generating" })
  })

  it.each([
    ["an undeclared success", 200, { status: "stopped" }],
    ["an undeclared conflict", 409, { message: "conflict" }],
    ["a missing reply", 404, buildReplyNotFoundProblem()],
    ["a server failure", 500, { detail: "boom" }]
  ])("rejects %s with its status", async (_label, status, body) => {
    startBackendFake({
      [REPLY_STOP_ROUTE]: () => buildJsonResponse(status, body)
    })

    await expect(
      stopChatReply(REPLY_TARGET, { backendUrl: FIXTURE_BACKEND_URL })
    ).rejects.toThrow(String(status))
  })

  it("rejects when the backend cannot be reached and keeps the transport failure as its cause", async () => {
    const transportFailure = createTransportFailure()
    startBackendFake({
      [REPLY_STOP_ROUTE]: () => Promise.reject(transportFailure)
    })

    await expect(
      stopChatReply(REPLY_TARGET, { backendUrl: FIXTURE_BACKEND_URL })
    ).rejects.toMatchObject({ cause: transportFailure })
  })
})

describe("sendChatToolResult", () => {
  it("sends the answer to the call's route and reports it accepted, without a cancellation signal", async () => {
    const backend = startBackendFake({
      [TOOL_RESULT_ROUTE]: () => new Response(null, { status: 204 })
    })

    await expect(
      sendChatToolResult(TOOL_CALL_TARGET, SUCCEEDED_TOOL_RESULT, {
        backendUrl: FIXTURE_BACKEND_URL
      })
    ).resolves.toEqual({ status: "accepted" })
    expect(backend.requests).toHaveLength(1)
    expect(backend.requests[0]?.url).toBe(
      `${FIXTURE_BACKEND_URL}/api/v1/chat/${REPLY_TARGET.conversationId}/replies/${REPLY_TARGET.assistantMessageId}/tool-results/${TOOL_CALL.id}`
    )
    expect(backend.requests[0]?.body).toEqual(SUCCEEDED_TOOL_RESULT)
    expect(backend.requests[0]?.headers.get("Content-Type")).toBe(
      "application/json"
    )
    expect(backend.requests[0]?.signal).toBeUndefined()
  })

  it("reports not pending for the declared conflict", async () => {
    startBackendFake({
      [TOOL_RESULT_ROUTE]: () =>
        buildJsonResponse(409, TOOL_CALL_NOT_PENDING_PROBLEM)
    })

    await expect(
      sendChatToolResult(TOOL_CALL_TARGET, SUCCEEDED_TOOL_RESULT, {
        backendUrl: FIXTURE_BACKEND_URL
      })
    ).resolves.toEqual({ status: "not-pending" })
  })

  it.each([
    ["an undeclared success", 200, { status: "accepted" }],
    [
      "another route's declared conflict",
      409,
      buildReplyNotGeneratingProblem()
    ],
    ["a body over the limit", 413, { message: "Request body is too large" }],
    ["a server failure", 500, { detail: "boom" }]
  ])("rejects %s with its status", async (_label, status, body) => {
    startBackendFake({
      [TOOL_RESULT_ROUTE]: () => buildJsonResponse(status, body)
    })

    await expect(
      sendChatToolResult(TOOL_CALL_TARGET, SUCCEEDED_TOOL_RESULT, {
        backendUrl: FIXTURE_BACKEND_URL
      })
    ).rejects.toThrow(String(status))
  })

  it("rejects when the backend cannot be reached and keeps the transport failure as its cause", async () => {
    const transportFailure = createTransportFailure()
    startBackendFake({
      [TOOL_RESULT_ROUTE]: () => Promise.reject(transportFailure)
    })

    await expect(
      sendChatToolResult(TOOL_CALL_TARGET, SUCCEEDED_TOOL_RESULT, {
        backendUrl: FIXTURE_BACKEND_URL
      })
    ).rejects.toMatchObject({ cause: transportFailure })
  })
})

describe("sendChatToolApproval", () => {
  it("sends the answer to the call's approval route and reports it accepted, without a cancellation signal", async () => {
    const backend = startBackendFake({
      [TOOL_APPROVAL_ROUTE]: () => new Response(null, { status: 204 })
    })

    await expect(
      sendChatToolApproval(TOOL_CALL_TARGET, ALLOWED_TOOL_APPROVAL, {
        backendUrl: FIXTURE_BACKEND_URL
      })
    ).resolves.toEqual({ status: "accepted" })
    expect(backend.requests).toHaveLength(1)
    expect(backend.requests[0]?.url).toBe(
      `${FIXTURE_BACKEND_URL}/api/v1/chat/${REPLY_TARGET.conversationId}/replies/${REPLY_TARGET.assistantMessageId}/tool-approvals/${TOOL_CALL.id}`
    )
    expect(backend.requests[0]?.body).toEqual({ status: "allowed" })
    expect(backend.requests[0]?.headers.get("Content-Type")).toBe(
      "application/json"
    )
    expect(backend.requests[0]?.signal).toBeUndefined()
  })

  it("reports not pending for the declared conflict", async () => {
    startBackendFake({
      [TOOL_APPROVAL_ROUTE]: () =>
        buildJsonResponse(409, TOOL_CALL_NOT_PENDING_PROBLEM)
    })

    await expect(
      sendChatToolApproval(TOOL_CALL_TARGET, ALLOWED_TOOL_APPROVAL, {
        backendUrl: FIXTURE_BACKEND_URL
      })
    ).resolves.toEqual({ status: "not-pending" })
  })

  it.each([
    ["an undeclared success", 200, { status: "accepted" }],
    [
      "another route's declared conflict",
      409,
      buildReplyNotGeneratingProblem()
    ],
    ["a server failure", 500, { detail: "boom" }]
  ])("rejects %s with its status", async (_label, status, body) => {
    startBackendFake({
      [TOOL_APPROVAL_ROUTE]: () => buildJsonResponse(status, body)
    })

    await expect(
      sendChatToolApproval(TOOL_CALL_TARGET, ALLOWED_TOOL_APPROVAL, {
        backendUrl: FIXTURE_BACKEND_URL
      })
    ).rejects.toThrow(String(status))
  })

  it("rejects when the backend cannot be reached and keeps the transport failure as its cause", async () => {
    const transportFailure = createTransportFailure()
    startBackendFake({
      [TOOL_APPROVAL_ROUTE]: () => Promise.reject(transportFailure)
    })

    await expect(
      sendChatToolApproval(TOOL_CALL_TARGET, ALLOWED_TOOL_APPROVAL, {
        backendUrl: FIXTURE_BACKEND_URL
      })
    ).rejects.toMatchObject({ cause: transportFailure })
  })
})

describe("getChatContextMeasurement", () => {
  /** Measurement request of a new conversation Caliginia answers. */
  const MEASUREMENT_REQUEST = Object.freeze({
    conversation: { kind: "new", agentCode: CALIGINIA_AGENT_CODE },
    model: "qwen3-8b"
  } as const)

  it("sends the request to the caller's backend with its signal, uncached, and returns the measurement", async () => {
    const backend = startBackendFake({
      [CHAT_CONTEXT_ROUTE]: () =>
        buildJsonResponse(200, FIXTURE_CHAT_CONTEXT_MEASUREMENT)
    })
    const { signal } = new AbortController()

    await expect(
      getChatContextMeasurement(MEASUREMENT_REQUEST, {
        backendUrl: FIXTURE_BACKEND_URL,
        signal
      })
    ).resolves.toEqual({
      status: "measured",
      measurement: FIXTURE_CHAT_CONTEXT_MEASUREMENT
    })
    expect(backend.requests[0]).toMatchObject({
      url: `${FIXTURE_BACKEND_URL}/api/v1/chat/context`,
      body: MEASUREMENT_REQUEST,
      cache: "no-store",
      signal
    })
  })

  it("reports a model LM Studio has not loaded", async () => {
    startBackendFake({
      [CHAT_CONTEXT_ROUTE]: () =>
        buildJsonResponse(503, {
          type: "urn:lys:problem:llm:model-not-loaded",
          title: "Model not loaded",
          status: 503,
          detail: "The model is not loaded in LM Studio."
        })
    })

    await expect(
      getChatContextMeasurement(MEASUREMENT_REQUEST, {
        backendUrl: FIXTURE_BACKEND_URL,
        signal: new AbortController().signal
      })
    ).resolves.toEqual({ status: "model-not-loaded" })
  })

  it.each([
    ["a busy model-operation queue", createLlmServiceBusyProblem()],
    [
      "an unreachable LM Studio",
      {
        type: "urn:lys:problem:llm:runtime-unavailable",
        title: "LLM runtime unavailable",
        status: 503,
        detail:
          "LM Studio is not reachable. Start LM Studio, then refresh its status in Lys."
      }
    ]
  ])("rejects with the backend's sentence for %s", async (_label, problem) => {
    startBackendFake({
      [CHAT_CONTEXT_ROUTE]: () => buildJsonResponse(503, problem)
    })

    await expect(
      getChatContextMeasurement(MEASUREMENT_REQUEST, {
        backendUrl: FIXTURE_BACKEND_URL,
        signal: new AbortController().signal
      })
    ).rejects.toThrow(problem.detail)
  })

  it.each([
    ["an undeclared problem", 404, { detail: "Not Found" }],
    ["a server failure", 500, { detail: "boom" }]
  ])("rejects %s with its status", async (_label, status, body) => {
    startBackendFake({
      [CHAT_CONTEXT_ROUTE]: () => buildJsonResponse(status, body)
    })

    await expect(
      getChatContextMeasurement(MEASUREMENT_REQUEST, {
        backendUrl: FIXTURE_BACKEND_URL,
        signal: new AbortController().signal
      })
    ).rejects.toThrow(
      `The context could not be measured (HTTP ${String(status)}).`
    )
  })

  it("rejects a measurement that does not match the contract, keeping the reason as its cause", async () => {
    startBackendFake({
      [CHAT_CONTEXT_ROUTE]: () =>
        buildJsonResponse(200, {
          ...FIXTURE_CHAT_CONTEXT_MEASUREMENT,
          contextLength: 0
        })
    })

    await expect(
      getChatContextMeasurement(MEASUREMENT_REQUEST, {
        backendUrl: FIXTURE_BACKEND_URL,
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({
      message: "The backend sent an invalid context measurement.",
      cause: expect.any(Error)
    })
  })

  it("rejects when the backend cannot be reached and keeps the transport failure as its cause", async () => {
    const transportFailure = createTransportFailure()
    startBackendFake({
      [CHAT_CONTEXT_ROUTE]: () => {
        throw transportFailure
      }
    })

    await expect(
      getChatContextMeasurement(MEASUREMENT_REQUEST, {
        backendUrl: FIXTURE_BACKEND_URL,
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({
      message: "The backend could not be reached.",
      cause: transportFailure
    })
  })

  it("rejects with the abort reason when the signal aborts", async () => {
    startBackendFake({
      [CHAT_CONTEXT_ROUTE]: () =>
        buildJsonResponse(200, FIXTURE_CHAT_CONTEXT_MEASUREMENT)
    })
    const controller = new AbortController()
    const reason = new Error("The composer moved on.")
    controller.abort(reason)

    await expect(
      getChatContextMeasurement(MEASUREMENT_REQUEST, {
        backendUrl: FIXTURE_BACKEND_URL,
        signal: controller.signal
      })
    ).rejects.toBe(reason)
  })
})
