import type {
  ChatToolApprovalAnswer,
  ChatToolCall,
  ChatToolResult
} from "@lys/protocol"
import { describe, expect, it, vi } from "vitest"
import { findShownToolCall, type HeldToolCall } from "@/lib/store/tool-calls"
import {
  buildJsonResponse,
  createControlledRoute,
  createTransportFailure,
  FIXTURE_BACKEND_URL,
  listRouteKeys,
  startBackendEventStream,
  startBackendFake,
  type BackendEventStream,
  type BackendFake,
  type BackendRoutes
} from "../../../support/backendFake"
import {
  buildCompletedAssistantMessage,
  buildFragmentPart,
  buildStreamingAssistantMessage,
  createFixtureUuidV7,
  FIXTURE_CONVERSATION_ID
} from "../../../support/conversationFixtures"
import { startNativeHostFake } from "../../../support/nativeHostFake"
import {
  createControlledPromise,
  waitForMicrotasks
} from "../../../support/settlement"
import {
  buildBackendToolDefinition,
  buildToolCall,
  buildToolDefinition
} from "../../../support/toolFixtures"

/** Desktop tool that reads one file on this machine. */
const READ_TEXT_FILE = buildToolDefinition("read_text_file")

/** Backend tool that requests one page off this machine. */
const READ_PAGE = buildBackendToolDefinition("read_page")

/** Reply the store follows in most cases. */
const REPLY = buildStreamingAssistantMessage(3, "")

/** Target of {@link REPLY} as the chat view hands it to the store. */
const REPLY_TARGET = Object.freeze({
  conversationId: FIXTURE_CONVERSATION_ID,
  assistantMessageId: REPLY.id
})

/** Route key of the reply-events endpoint for {@link REPLY_TARGET}. */
const EVENTS_ROUTE = `GET /api/v1/chat/${REPLY_TARGET.conversationId}/replies/${REPLY_TARGET.assistantMessageId}/events`

/** First call of {@link REPLY}: a read of the fixture notes. */
const READ_CALL = buildToolCall(10, "read_text_file")

/** Second call of {@link REPLY}: a read of another file. */
const SECOND_READ_CALL = buildToolCall(11, "read_text_file", {
  path: "/notes/done.md"
})

/** Call of {@link REPLY} to the backend's tool. */
const PAGE_CALL = buildToolCall(12, "read_page", {
  url: "https://example.com/docs"
})

/** Validated input of {@link READ_CALL}. */
const READ_INPUT = Object.freeze({
  runner: "client",
  toolName: "read_text_file",
  input: { path: "/notes/todo.md" }
})

/** Answer of a read that returned the fixture notes. */
const READ_RESULT = Object.freeze({
  status: "succeeded",
  content: "Buy milk."
} satisfies ChatToolResult)

/** Answer of a person who rejected a call without a reason. */
const DECLINED_APPROVAL = Object.freeze({
  status: "rejected",
  reason: "declined",
  content: "The person declined this call."
} satisfies ChatToolApprovalAnswer)

/** Answer of a person who allowed a call. */
const ALLOWED_APPROVAL = Object.freeze({
  status: "allowed"
} satisfies ChatToolApprovalAnswer)

/** Bodyless success of the tool-result and tool-approval endpoints. */
const ACCEPTED_STATUS = 204

/** Failure a broken store listener throws. */
const LISTENER_FAILURE = new Error("A listener failed.")

/**
 * Handles a tool-call state change the way a broken store listener would.
 *
 * @param state - State after the change.
 * @throws {@link LISTENER_FAILURE} once the first held call is answered.
 */
function handleAnsweredToolCallStateChange(state: {
  readonly heldCalls: readonly HeldToolCall[]
}): void {
  if (state.heldCalls[0]?.answer.status === "answered") throw LISTENER_FAILURE
}

/** Event that sends a text part of {@link REPLY}, which the follow ignores. */
const READING_PART_EVENT = Object.freeze({
  type: "reply-part",
  part: buildFragmentPart("text", 40, 0, "Reading")
})

/**
 * Builds the snapshot that starts every stream of {@link REPLY} while it is
 * generating.
 *
 * @param pendingToolApprovals - Calls the backend still shows for approval.
 * @param pendingToolCalls - Calls the backend still waits to be run.
 * @returns The snapshot event.
 */
function buildStreamingSnapshot(
  pendingToolApprovals: readonly ChatToolCall[] = [],
  pendingToolCalls: readonly ChatToolCall[] = []
) {
  return {
    type: "reply-snapshot",
    conversationTitle: null,
    assistantMessage: REPLY,
    sources: [],
    pendingToolCalls,
    pendingToolApprovals
  }
}

/**
 * Builds the event that shows one call for approval.
 *
 * @param call - Call shown.
 * @returns The `tool-approval` event.
 */
function buildApprovalEvent(call: ChatToolCall) {
  return { type: "tool-approval", call }
}

/**
 * Builds the event that asks the desktop to run one call.
 *
 * @param call - Call to run.
 * @returns The `tool-call` event.
 */
function buildRunEvent(call: ChatToolCall) {
  return { type: "tool-call", call }
}

/**
 * Builds the route key of the tool-result endpoint for one call of
 * {@link REPLY}.
 *
 * @param call - Call being answered.
 * @returns The `"<METHOD> <path>"` key.
 */
function buildToolResultRouteKey(call: ChatToolCall): string {
  return `POST /api/v1/chat/${REPLY_TARGET.conversationId}/replies/${REPLY_TARGET.assistantMessageId}/tool-results/${call.id}`
}

/**
 * Builds the route key of the tool-approval endpoint for one call of
 * {@link REPLY}.
 *
 * @param call - Call being answered.
 * @returns The `"<METHOD> <path>"` key.
 */
function buildToolApprovalRouteKey(call: ChatToolCall): string {
  return `POST /api/v1/chat/${REPLY_TARGET.conversationId}/replies/${REPLY_TARGET.assistantMessageId}/tool-approvals/${call.id}`
}

/**
 * Builds tool-approval and tool-result routes that take every answer to one
 * call of {@link REPLY}.
 *
 * @param call - Call being answered.
 * @returns The routes under their keys.
 */
function buildAcceptingToolCallRoutes(call: ChatToolCall): BackendRoutes {
  return {
    [buildToolApprovalRouteKey(call)]: () =>
      new Response(null, { status: ACCEPTED_STATUS }),
    [buildToolResultRouteKey(call)]: () =>
      new Response(null, { status: ACCEPTED_STATUS })
  }
}

/**
 * Starts a backend whose reply-events route for {@link REPLY} opens a new
 * event stream per request.
 *
 * @param routes - Other routes the case needs, such as tool-result routes.
 * @returns The backend observation handle and the opened reply streams.
 */
function startReplyBackend(routes: BackendRoutes = {}) {
  const replyStreams: BackendEventStream[] = []
  const backend = startBackendFake({
    [EVENTS_ROUTE]: () => {
      const stream = startBackendEventStream()
      replyStreams.push(stream)
      return stream.response
    },
    ...routes
  })
  return { backend, replyStreams }
}

/**
 * Starts a backend that cannot serve the second request for {@link REPLY}'s
 * events, which ends the store's follow while the reply still generates;
 * every other request opens a new event stream.
 *
 * @param routes - Other routes the case needs, such as tool-result routes.
 * @returns The backend observation handle and the opened reply streams.
 */
function startInterruptedReplyBackend(routes: BackendRoutes = {}) {
  const replyStreams: BackendEventStream[] = []
  let eventRequestCount = 0

  /**
   * Handles one request for {@link REPLY}'s events.
   *
   * @returns A bodyless 500 for the second request, which opens no stream;
   * for every other request, the response of a new event stream, which is
   * added to the opened reply streams.
   */
  function handleReplyEventsRequest(): Response {
    eventRequestCount += 1
    if (eventRequestCount === 2) return new Response(null, { status: 500 })
    const stream = startBackendEventStream()
    replyStreams.push(stream)
    return stream.response
  }

  const backend = startBackendFake({
    [EVENTS_ROUTE]: handleReplyEventsRequest,
    ...routes
  })
  return { backend, replyStreams }
}

/**
 * Lists the answers a backend received at the tool-approval and tool-result
 * endpoints.
 *
 * @param backend - Backend observation handle.
 * @returns The endpoint and JSON body of each answer, in arrival order.
 */
function listToolAnswers(backend: BackendFake): unknown[] {
  return backend.requests
    .filter((request) => request.method === "POST")
    .map((request) => ({
      endpoint: request.url.includes("/tool-approvals/")
        ? "tool-approvals"
        : "tool-results",
      body: request.body
    }))
}

/**
 * Builds one answer as {@link listToolAnswers} lists it.
 *
 * @param body - Approval answer or tool result.
 * @returns The answer with the endpoint its kind goes to.
 */
function buildSentAnswer(body: ChatToolApprovalAnswer | ChatToolResult) {
  return {
    endpoint:
      body.status === "allowed" || body.status === "rejected"
        ? "tool-approvals"
        : "tool-results",
    body
  }
}

/**
 * Loads fresh application, tool, and tool-call stores: the backend is at
 * {@link FIXTURE_BACKEND_URL}, both fixture tools are listed, and no reply is
 * followed.
 *
 * @returns The tool and tool-call store hooks of newly evaluated modules.
 */
async function loadFreshToolCallStore() {
  vi.resetModules()
  const { useLysStore } = await import("@/lib/store")
  const { useToolStore } = await import("@/lib/store/tools")
  const { useToolCallStore } = await import("@/lib/store/tool-calls")
  useLysStore.setState({ backendUrl: FIXTURE_BACKEND_URL })
  useToolStore.setState({
    list: {
      status: "loaded",
      tools: [READ_TEXT_FILE, READ_PAGE],
      unavailableTools: new Map()
    }
  })
  return { useLysStore, useToolStore, useToolCallStore }
}

/** Tool-call store hook of a freshly evaluated store module. */
type ToolCallStoreHook = Awaited<
  ReturnType<typeof loadFreshToolCallStore>
>["useToolCallStore"]

/**
 * Starts following {@link REPLY} and delivers its first events.
 *
 * @param useToolCallStore - Fresh tool-call store.
 * @param replyStreams - Streams the backend opened so far.
 * @param events - Events the backend sends on the first stream, in order.
 * @returns The first stream, once the store has handled the events.
 */
async function startFollowWithEvents(
  useToolCallStore: ToolCallStoreHook,
  replyStreams: readonly BackendEventStream[],
  events: readonly unknown[]
): Promise<BackendEventStream> {
  useToolCallStore.getState().startReplyToolCallFollow(REPLY_TARGET)
  await waitForMicrotasks()
  const [stream] = replyStreams
  if (stream === undefined) throw new Error("The reply was not followed.")
  events.forEach(stream.sendEvent)
  await waitForMicrotasks()
  return stream
}

/**
 * Ends the store's follow of {@link REPLY} through a stream failure, then
 * follows the reply again while the backend still waits on
 * {@link READ_CALL}.
 *
 * @param useToolCallStore - Tool-call store following the reply on a backend
 * started by {@link startInterruptedReplyBackend}.
 * @param firstStream - Stream of the first follow, which brought the call.
 * @param snapshot - Snapshot the new follow starts with, listing the call.
 * @param replyStreams - Streams the backend opened so far.
 * @returns Resolves once the new follow's snapshot was handled.
 */
async function startFollowAfterStreamFailure(
  useToolCallStore: ToolCallStoreHook,
  firstStream: BackendEventStream,
  snapshot: ReturnType<typeof buildStreamingSnapshot>,
  replyStreams: readonly BackendEventStream[]
): Promise<void> {
  // The early close makes the store follow again; that request fails.
  firstStream.close()
  await waitForMicrotasks()
  useToolCallStore.getState().startReplyToolCallFollow(REPLY_TARGET)
  await waitForMicrotasks()
  replyStreams[1]?.sendEvent(snapshot)
  await waitForMicrotasks()
}

/**
 * Builds one held call of a conversation, shown for approval, for the
 * selector cases.
 *
 * @param sequence - Identity sequence of the call.
 * @param conversationId - Conversation whose reply made the call.
 * @param answer - Where the call's answer stands.
 * @returns The held call.
 */
function buildHeldToolCall(
  sequence: number,
  conversationId: string,
  answer: Extract<HeldToolCall, { step: "approval" }>["answer"]
): HeldToolCall {
  const call = buildToolCall(sequence, "read_text_file")
  return {
    target: { conversationId, assistantMessageId: REPLY.id, callId: call.id },
    call,
    step: "approval",
    answer
  }
}

/**
 * Builds one held call of a conversation that the backend sent to run, for
 * the selector cases.
 *
 * @param sequence - Identity sequence of the call.
 * @param conversationId - Conversation whose reply made the call.
 * @returns The held call, running.
 */
function buildRunningToolCall(
  sequence: number,
  conversationId: string
): HeldToolCall {
  const call = buildToolCall(sequence, "read_text_file")
  return {
    target: { conversationId, assistantMessageId: REPLY.id, callId: call.id },
    call,
    step: "run",
    answer: { status: "running" }
  }
}

describe("findShownToolCall", () => {
  /** Conversation whose calls the selector cases look for. */
  const shownConversationId = FIXTURE_CONVERSATION_ID
  /** Another conversation with calls of its own. */
  const otherConversationId = createFixtureUuidV7(2)
  /** Answer of a call that waits for the person. */
  const awaitingPerson = {
    status: "awaiting-person",
    definition: READ_TEXT_FILE,
    input: {
      runner: "client",
      toolName: "read_text_file",
      input: { path: "/notes/todo.md" }
    }
  } as const

  it("shows nothing before a conversation is shown", () => {
    const heldCalls = [
      buildHeldToolCall(20, shownConversationId, awaitingPerson)
    ]

    expect(findShownToolCall({ heldCalls }, undefined)).toBeUndefined()
  })

  it("shows the earliest call of the shown conversation that needs the person, as the same object", () => {
    const earliestWaiting = buildHeldToolCall(
      23,
      shownConversationId,
      awaitingPerson
    )
    const heldCalls = [
      buildHeldToolCall(20, otherConversationId, awaitingPerson),
      buildRunningToolCall(21, shownConversationId),
      buildHeldToolCall(22, shownConversationId, { status: "answered" }),
      earliestWaiting,
      buildHeldToolCall(24, shownConversationId, awaitingPerson)
    ]

    expect(findShownToolCall({ heldCalls }, shownConversationId)).toBe(
      earliestWaiting
    )
  })

  it("shows a call whose answer failed to send", () => {
    const unsent = buildHeldToolCall(21, shownConversationId, {
      status: "send-failed",
      toolAnswer: DECLINED_APPROVAL,
      error: "Couldn't send the answer to Lys."
    })
    const heldCalls = [
      buildHeldToolCall(20, shownConversationId, {
        status: "sending",
        toolAnswer: DECLINED_APPROVAL
      }),
      unsent
    ]

    expect(findShownToolCall({ heldCalls }, shownConversationId)).toBe(unsent)
  })

  it("shows nothing while every call of the conversation is being handled without the person", () => {
    const heldCalls = [
      buildRunningToolCall(20, shownConversationId),
      buildHeldToolCall(21, otherConversationId, awaitingPerson)
    ]

    expect(
      findShownToolCall({ heldCalls }, shownConversationId)
    ).toBeUndefined()
  })
})

describe("useToolCallStore", () => {
  it("starts holding no call", async () => {
    const { useToolCallStore } = await loadFreshToolCallStore()

    expect(useToolCallStore.getState().heldCalls).toEqual([])
  })

  describe("startReplyToolCallFollow", () => {
    it("follows the reply once at the application store's backend, however often it is asked to", async () => {
      const { backend } = startReplyBackend()
      const { useToolCallStore } = await loadFreshToolCallStore()

      useToolCallStore.getState().startReplyToolCallFollow(REPLY_TARGET)
      useToolCallStore.getState().startReplyToolCallFollow(REPLY_TARGET)
      await waitForMicrotasks()

      expect(backend.requests.map((request) => request.url)).toEqual([
        `${FIXTURE_BACKEND_URL}/api/v1/chat/${REPLY_TARGET.conversationId}/replies/${REPLY_TARGET.assistantMessageId}/events`
      ])
    })

    it("holds a call shown for approval for the person, without answering it", async () => {
      const { backend, replyStreams } = startReplyBackend()
      const { useToolCallStore } = await loadFreshToolCallStore()

      await startFollowWithEvents(useToolCallStore, replyStreams, [
        buildStreamingSnapshot(),
        buildApprovalEvent(READ_CALL)
      ])

      expect(useToolCallStore.getState().heldCalls).toEqual([
        {
          target: { ...REPLY_TARGET, callId: READ_CALL.id },
          call: READ_CALL,
          step: "approval",
          answer: {
            status: "awaiting-person",
            definition: READ_TEXT_FILE,
            input: READ_INPUT
          }
        }
      ])
      expect(listToolAnswers(backend)).toEqual([])
    })

    it("holds the prompts a snapshot lists, then later prompts, in arrival order", async () => {
      const { replyStreams } = startReplyBackend()
      const { useToolCallStore } = await loadFreshToolCallStore()

      await startFollowWithEvents(useToolCallStore, replyStreams, [
        buildStreamingSnapshot([READ_CALL, PAGE_CALL]),
        READING_PART_EVENT,
        { type: "title", title: "Notes" },
        buildApprovalEvent(SECOND_READ_CALL)
      ])

      expect(
        useToolCallStore.getState().heldCalls.map(({ call, answer }) => ({
          callId: call.id,
          status: answer.status
        }))
      ).toEqual([
        { callId: READ_CALL.id, status: "awaiting-person" },
        { callId: PAGE_CALL.id, status: "awaiting-person" },
        { callId: SECOND_READ_CALL.id, status: "awaiting-person" }
      ])
    })

    it("runs the calls a snapshot lists as waiting to run", async () => {
      const host = startNativeHostFake({ read_text_file: () => "Buy milk." })
      const { backend, replyStreams } = startReplyBackend(
        buildAcceptingToolCallRoutes(READ_CALL)
      )
      const { useToolCallStore } = await loadFreshToolCallStore()

      await startFollowWithEvents(useToolCallStore, replyStreams, [
        buildStreamingSnapshot([PAGE_CALL], [READ_CALL])
      ])

      expect(host.commands).toEqual([
        { command: "read_text_file", args: { path: "/notes/todo.md" } }
      ])
      expect(listToolAnswers(backend)).toEqual([buildSentAnswer(READ_RESULT)])
      expect(
        useToolCallStore.getState().heldCalls.map(({ call, step, answer }) => ({
          callId: call.id,
          step,
          status: answer.status
        }))
      ).toEqual([
        { callId: PAGE_CALL.id, step: "approval", status: "awaiting-person" },
        { callId: READ_CALL.id, step: "run", status: "answered" }
      ])
    })

    it("reads the tool list before showing a prompt when it has not been read", async () => {
      const host = startNativeHostFake({ list_tools: () => [READ_TEXT_FILE] })
      const { replyStreams } = startReplyBackend({
        "GET /api/v1/tools": () =>
          buildJsonResponse(200, { tools: [], unavailableTools: [] })
      })
      const { useToolStore, useToolCallStore } = await loadFreshToolCallStore()
      useToolStore.setState({ list: { status: "idle" } })

      await startFollowWithEvents(useToolCallStore, replyStreams, [
        buildStreamingSnapshot(),
        buildApprovalEvent(READ_CALL)
      ])

      expect(host.commands).toEqual([{ command: "list_tools", args: {} }])
      expect(useToolCallStore.getState().heldCalls).toMatchObject([
        { answer: { status: "awaiting-person", definition: READ_TEXT_FILE } }
      ])
    })

    it("answers a prompt it cannot show at once, when the tool list cannot be read", async () => {
      startNativeHostFake({
        list_tools: () => Promise.reject("command list_tools not found")
      })
      const { backend, replyStreams } = startReplyBackend({
        "GET /api/v1/tools": () =>
          buildJsonResponse(200, { tools: [], unavailableTools: [] }),
        ...buildAcceptingToolCallRoutes(READ_CALL)
      })
      const { useToolStore, useToolCallStore } = await loadFreshToolCallStore()
      useToolStore.setState({ list: { status: "idle" } })

      await startFollowWithEvents(useToolCallStore, replyStreams, [
        buildStreamingSnapshot(),
        buildApprovalEvent(READ_CALL)
      ])

      expect(listToolAnswers(backend)).toEqual([
        buildSentAnswer({
          status: "rejected",
          reason: "showFailed",
          content: "The desktop couldn't read its tool list."
        })
      ])
      expect(
        findShownToolCall(
          useToolCallStore.getState(),
          REPLY_TARGET.conversationId
        )
      ).toBeUndefined()
    })

    it("runs a call the backend sends to run at once and sends its result, showing the person nothing", async () => {
      const read = createControlledPromise<unknown>()
      const host = startNativeHostFake({ read_text_file: () => read.promise })
      const toolResult = createControlledRoute()
      const { backend, replyStreams } = startReplyBackend({
        [buildToolResultRouteKey(READ_CALL)]: toolResult.route
      })
      const { useToolCallStore } = await loadFreshToolCallStore()

      await startFollowWithEvents(useToolCallStore, replyStreams, [
        buildStreamingSnapshot(),
        buildRunEvent(READ_CALL)
      ])
      const whileRunning = useToolCallStore.getState()
      read.resolve("Buy milk.")
      await waitForMicrotasks()
      const whileSending = useToolCallStore.getState()
      toolResult.responses[0]?.resolve(
        new Response(null, { status: ACCEPTED_STATUS })
      )
      await waitForMicrotasks()

      expect(host.commands).toEqual([
        { command: "read_text_file", args: { path: "/notes/todo.md" } }
      ])
      expect(whileRunning.heldCalls).toMatchObject([
        { step: "run", answer: { status: "running" } }
      ])
      expect(whileSending.heldCalls).toMatchObject([
        { answer: { status: "sending", toolAnswer: READ_RESULT } }
      ])
      expect(
        [whileRunning, whileSending].map((state) =>
          findShownToolCall(state, REPLY_TARGET.conversationId)
        )
      ).toEqual([undefined, undefined])
      expect(listToolAnswers(backend)).toEqual([buildSentAnswer(READ_RESULT)])
      expect(useToolCallStore.getState().heldCalls).toMatchObject([
        { call: READ_CALL, answer: { status: "answered" } }
      ])
    })

    it("runs a call the backend sends to run whatever the tool switches say, since the backend decides", async () => {
      const host = startNativeHostFake({ read_text_file: () => "Buy milk." })
      const { backend, replyStreams } = startReplyBackend(
        buildAcceptingToolCallRoutes(READ_CALL)
      )
      const { useToolStore, useToolCallStore } = await loadFreshToolCallStore()
      useToolStore.getState().updateToolCallsOn(false)
      useToolStore.getState().updateToolOn(READ_TEXT_FILE, false)

      await startFollowWithEvents(useToolCallStore, replyStreams, [
        buildStreamingSnapshot(),
        buildRunEvent(READ_CALL)
      ])

      expect(host.commands).toHaveLength(1)
      expect(listToolAnswers(backend)).toEqual([buildSentAnswer(READ_RESULT)])
    })

    it("runs a call sent to run while its card still waits for the person, in place of the card, since it does not check who allowed it", async () => {
      const host = startNativeHostFake({ read_text_file: () => "Buy milk." })
      const { backend, replyStreams } = startReplyBackend(
        buildAcceptingToolCallRoutes(READ_CALL)
      )
      const { useToolCallStore } = await loadFreshToolCallStore()
      const stream = await startFollowWithEvents(
        useToolCallStore,
        replyStreams,
        [buildStreamingSnapshot(), buildApprovalEvent(READ_CALL)]
      )
      const whileWaiting = useToolCallStore.getState()

      stream.sendEvent(buildRunEvent(READ_CALL))
      await waitForMicrotasks()

      expect(
        findShownToolCall(whileWaiting, REPLY_TARGET.conversationId)?.call
      ).toEqual(READ_CALL)
      expect(host.commands).toHaveLength(1)
      expect(listToolAnswers(backend)).toEqual([buildSentAnswer(READ_RESULT)])
      expect(
        findShownToolCall(
          useToolCallStore.getState(),
          REPLY_TARGET.conversationId
        )
      ).toBeUndefined()
    })

    it("answers a call it cannot run as not run", async () => {
      const host = startNativeHostFake({})
      const call = buildToolCall(13, "delete_file")
      const { backend, replyStreams } = startReplyBackend(
        buildAcceptingToolCallRoutes(call)
      )
      const { useToolCallStore } = await loadFreshToolCallStore()

      await startFollowWithEvents(useToolCallStore, replyStreams, [
        buildStreamingSnapshot(),
        buildRunEvent(call)
      ])

      expect(host.commands).toEqual([])
      expect(listToolAnswers(backend)).toEqual([
        buildSentAnswer({
          status: "failed",
          reason: "runFailed",
          content: expect.stringContaining("delete_file")
        })
      ])
    })

    it.each([
      ["completes", { type: "done", finishReason: "stop" }],
      ["is interrupted", { type: "interrupted" }],
      ["fails", { type: "error", message: "The model stopped answering." }]
    ])(
      "drops every held call and stops reading once the reply %s",
      async (_label, finalEvent) => {
        const { backend, replyStreams } = startReplyBackend()
        const { useToolCallStore } = await loadFreshToolCallStore()
        const stream = await startFollowWithEvents(
          useToolCallStore,
          replyStreams,
          [buildStreamingSnapshot(), buildApprovalEvent(READ_CALL)]
        )

        stream.sendEvent(finalEvent)
        await waitForMicrotasks()

        expect(useToolCallStore.getState().heldCalls).toEqual([])
        expect(stream.isCancelled()).toBe(true)
        expect(backend.requests).toHaveLength(1)
      }
    )

    it("stops at once when the snapshot shows the reply is no longer generating", async () => {
      const { backend, replyStreams } = startReplyBackend()
      const { useToolCallStore } = await loadFreshToolCallStore()

      const stream = await startFollowWithEvents(
        useToolCallStore,
        replyStreams,
        [
          {
            type: "reply-snapshot",
            conversationTitle: null,
            assistantMessage: buildCompletedAssistantMessage(3, "Done."),
            sources: [],
            pendingToolCalls: [],
            pendingToolApprovals: []
          }
        ]
      )

      expect(stream.isCancelled()).toBe(true)
      expect(backend.requests).toHaveLength(1)
    })

    it("follows a reply again once its earlier follow ended", async () => {
      const { backend, replyStreams } = startReplyBackend()
      const { useToolCallStore } = await loadFreshToolCallStore()
      await startFollowWithEvents(useToolCallStore, replyStreams, [
        buildStreamingSnapshot(),
        { type: "interrupted" }
      ])

      useToolCallStore.getState().startReplyToolCallFollow(REPLY_TARGET)
      await waitForMicrotasks()

      expect(listRouteKeys(backend)).toEqual([EVENTS_ROUTE, EVENTS_ROUTE])
    })

    it("follows again after the stream closes early, keeping a waiting prompt and not asking twice", async () => {
      const { backend, replyStreams } = startReplyBackend()
      const { useToolCallStore } = await loadFreshToolCallStore()
      const firstStream = await startFollowWithEvents(
        useToolCallStore,
        replyStreams,
        [buildStreamingSnapshot(), buildApprovalEvent(READ_CALL)]
      )
      const [waitingCall] = useToolCallStore.getState().heldCalls

      firstStream.close()
      await waitForMicrotasks()
      replyStreams[1]?.sendEvent(buildStreamingSnapshot([READ_CALL]))
      await waitForMicrotasks()

      expect(listRouteKeys(backend)).toEqual([EVENTS_ROUTE, EVENTS_ROUTE])
      expect(useToolCallStore.getState().heldCalls).toEqual([waitingCall])
      expect(useToolCallStore.getState().heldCalls[0]).toBe(waitingCall)
    })

    it("keeps an answered prompt answered when a later snapshot still lists it as waiting", async () => {
      const { backend, replyStreams } = startReplyBackend(
        buildAcceptingToolCallRoutes(READ_CALL)
      )
      const { useToolCallStore } = await loadFreshToolCallStore()
      const firstStream = await startFollowWithEvents(
        useToolCallStore,
        replyStreams,
        [buildStreamingSnapshot(), buildApprovalEvent(READ_CALL)]
      )
      await useToolCallStore.getState().rejectToolCall(READ_CALL.id, "")

      firstStream.close()
      await waitForMicrotasks()
      replyStreams[1]?.sendEvent(buildStreamingSnapshot([READ_CALL]))
      await waitForMicrotasks()

      expect(useToolCallStore.getState().heldCalls).toMatchObject([
        { call: READ_CALL, answer: { status: "answered" } }
      ])
      expect(listToolAnswers(backend)).toEqual([
        buildSentAnswer(DECLINED_APPROVAL)
      ])
    })

    it("stops after two streams in a row close without an event past the snapshot", async () => {
      const { backend, replyStreams } = startReplyBackend()
      const { useToolCallStore } = await loadFreshToolCallStore()
      const firstStream = await startFollowWithEvents(
        useToolCallStore,
        replyStreams,
        [buildStreamingSnapshot([READ_CALL])]
      )

      firstStream.close()
      await waitForMicrotasks()
      replyStreams[1]?.sendEvent(buildStreamingSnapshot([READ_CALL]))
      replyStreams[1]?.close()
      await waitForMicrotasks()

      expect(listRouteKeys(backend)).toEqual([EVENTS_ROUTE, EVENTS_ROUTE])
      expect(useToolCallStore.getState().heldCalls).toEqual([])
    })

    it("counts the closes afresh after a stream that brought an event past the snapshot", async () => {
      const { backend, replyStreams } = startReplyBackend()
      const { useToolCallStore } = await loadFreshToolCallStore()
      const firstStream = await startFollowWithEvents(
        useToolCallStore,
        replyStreams,
        [buildStreamingSnapshot()]
      )
      firstStream.close()
      await waitForMicrotasks()

      replyStreams[1]?.sendEvent(buildStreamingSnapshot())
      replyStreams[1]?.sendEvent(READING_PART_EVENT)
      replyStreams[1]?.close()
      await waitForMicrotasks()
      replyStreams[2]?.sendEvent(buildStreamingSnapshot())
      replyStreams[2]?.close()
      await waitForMicrotasks()
      const requestsWhileFollowing = backend.requests.length
      replyStreams[3]?.sendEvent(buildStreamingSnapshot())
      replyStreams[3]?.close()
      await waitForMicrotasks()

      expect(requestsWhileFollowing).toBe(4)
      expect(backend.requests).toHaveLength(4)
    })

    it("stops following and drops the reply's calls when the stream cannot be read", async () => {
      const { backend, replyStreams } = startInterruptedReplyBackend()
      const { useToolCallStore } = await loadFreshToolCallStore()
      const firstStream = await startFollowWithEvents(
        useToolCallStore,
        replyStreams,
        [buildStreamingSnapshot(), buildApprovalEvent(READ_CALL)]
      )

      firstStream.close()
      await waitForMicrotasks()

      expect(listRouteKeys(backend)).toEqual([EVENTS_ROUTE, EVENTS_ROUTE])
      expect(useToolCallStore.getState().heldCalls).toEqual([])
    })

    it.each([
      ["does not start with a snapshot", [buildApprovalEvent(READ_CALL)]],
      [
        "sends a second snapshot",
        [buildStreamingSnapshot([READ_CALL]), buildStreamingSnapshot()]
      ]
    ])("stops following when the stream %s", async (_label, events) => {
      const { backend, replyStreams } = startReplyBackend()
      const { useToolCallStore } = await loadFreshToolCallStore()

      const stream = await startFollowWithEvents(
        useToolCallStore,
        replyStreams,
        events
      )

      expect(stream.isCancelled()).toBe(true)
      expect(useToolCallStore.getState().heldCalls).toEqual([])
      expect(backend.requests).toHaveLength(1)
    })

    it("follows several replies at once and drops only the calls of the one that ends", async () => {
      const otherReply = buildStreamingAssistantMessage(5, "")
      const otherTarget = {
        conversationId: createFixtureUuidV7(4),
        assistantMessageId: otherReply.id
      }
      const otherStream = startBackendEventStream()
      const { replyStreams } = startReplyBackend({
        [`GET /api/v1/chat/${otherTarget.conversationId}/replies/${otherTarget.assistantMessageId}/events`]:
          () => otherStream.response
      })
      const { useToolCallStore } = await loadFreshToolCallStore()
      const stream = await startFollowWithEvents(
        useToolCallStore,
        replyStreams,
        [buildStreamingSnapshot(), buildApprovalEvent(READ_CALL)]
      )
      useToolCallStore.getState().startReplyToolCallFollow(otherTarget)
      await waitForMicrotasks()
      otherStream.sendEvent({
        type: "reply-snapshot",
        conversationTitle: null,
        assistantMessage: otherReply,
        sources: [],
        pendingToolCalls: [],
        pendingToolApprovals: [SECOND_READ_CALL]
      })
      await waitForMicrotasks()
      const whileBothWait = useToolCallStore.getState()

      stream.sendEvent({ type: "done", finishReason: "stop" })
      await waitForMicrotasks()

      expect(
        findShownToolCall(whileBothWait, REPLY_TARGET.conversationId)?.call
      ).toEqual(READ_CALL)
      expect(
        findShownToolCall(whileBothWait, otherTarget.conversationId)?.call
      ).toEqual(SECOND_READ_CALL)
      expect(useToolCallStore.getState().heldCalls).toMatchObject([
        { target: { ...otherTarget, callId: SECOND_READ_CALL.id } }
      ])
    })
  })

  describe("resolveToolCall", () => {
    it("allows a desktop tool's call and runs it once the backend sends it to run, under the same identifier", async () => {
      const host = startNativeHostFake({ read_text_file: () => "Buy milk." })
      const { backend, replyStreams } = startReplyBackend(
        buildAcceptingToolCallRoutes(READ_CALL)
      )
      const { useToolCallStore } = await loadFreshToolCallStore()
      const stream = await startFollowWithEvents(
        useToolCallStore,
        replyStreams,
        [buildStreamingSnapshot(), buildApprovalEvent(READ_CALL)]
      )

      await useToolCallStore.getState().resolveToolCall(READ_CALL.id)
      const afterAllowing = useToolCallStore.getState()
      stream.sendEvent(buildRunEvent(READ_CALL))
      await waitForMicrotasks()

      expect(afterAllowing.heldCalls).toMatchObject([
        { step: "approval", answer: { status: "answered" } }
      ])
      expect(host.commands).toEqual([
        { command: "read_text_file", args: { path: "/notes/todo.md" } }
      ])
      expect(listToolAnswers(backend)).toEqual([
        buildSentAnswer(ALLOWED_APPROVAL),
        buildSentAnswer(READ_RESULT)
      ])
      expect(useToolCallStore.getState().heldCalls).toMatchObject([
        { call: READ_CALL, step: "run", answer: { status: "answered" } }
      ])
    })

    it("runs a call whose run request arrives while its allowed answer is still being sent, and still sends the result", async () => {
      startNativeHostFake({ read_text_file: () => "Buy milk." })
      const approval = createControlledRoute()
      const { backend, replyStreams } = startReplyBackend({
        [buildToolApprovalRouteKey(READ_CALL)]: approval.route,
        [buildToolResultRouteKey(READ_CALL)]: () =>
          new Response(null, { status: ACCEPTED_STATUS })
      })
      const { useToolCallStore } = await loadFreshToolCallStore()
      const stream = await startFollowWithEvents(
        useToolCallStore,
        replyStreams,
        [buildStreamingSnapshot(), buildApprovalEvent(READ_CALL)]
      )

      const resolution = useToolCallStore
        .getState()
        .resolveToolCall(READ_CALL.id)
      await waitForMicrotasks()
      stream.sendEvent(buildRunEvent(READ_CALL))
      await waitForMicrotasks()
      approval.responses[0]?.resolve(
        new Response(null, { status: ACCEPTED_STATUS })
      )
      await resolution
      await waitForMicrotasks()

      expect(listToolAnswers(backend)).toEqual([
        buildSentAnswer(ALLOWED_APPROVAL),
        buildSentAnswer(READ_RESULT)
      ])
      expect(useToolCallStore.getState().heldCalls).toMatchObject([
        { step: "run", answer: { status: "answered" } }
      ])
    })

    it("sends the failure a desktop tool declared, for the model to read", async () => {
      startNativeHostFake({
        read_text_file: () => Promise.reject({ code: "fileNotFound" })
      })
      const { backend, replyStreams } = startReplyBackend(
        buildAcceptingToolCallRoutes(READ_CALL)
      )
      const { useToolCallStore } = await loadFreshToolCallStore()

      await startFollowWithEvents(useToolCallStore, replyStreams, [
        buildStreamingSnapshot(),
        buildRunEvent(READ_CALL)
      ])

      expect(listToolAnswers(backend)).toEqual([
        buildSentAnswer({
          status: "failed",
          reason: "toolFailed",
          content: JSON.stringify({ code: "fileNotFound" })
        })
      ])
    })

    it("allows a backend tool's call, running nothing on the desktop", async () => {
      const host = startNativeHostFake({})
      const { backend, replyStreams } = startReplyBackend(
        buildAcceptingToolCallRoutes(PAGE_CALL)
      )
      const { useToolCallStore } = await loadFreshToolCallStore()
      await startFollowWithEvents(useToolCallStore, replyStreams, [
        buildStreamingSnapshot(),
        buildApprovalEvent(PAGE_CALL)
      ])

      await useToolCallStore.getState().resolveToolCall(PAGE_CALL.id)

      expect(listToolAnswers(backend)).toEqual([
        buildSentAnswer(ALLOWED_APPROVAL)
      ])
      expect(host.commands).toEqual([])
    })

    it("sends the answer once when it is pressed twice", async () => {
      const { backend, replyStreams } = startReplyBackend(
        buildAcceptingToolCallRoutes(READ_CALL)
      )
      const { useToolCallStore } = await loadFreshToolCallStore()
      await startFollowWithEvents(useToolCallStore, replyStreams, [
        buildStreamingSnapshot(),
        buildApprovalEvent(READ_CALL)
      ])

      await Promise.all([
        useToolCallStore.getState().resolveToolCall(READ_CALL.id),
        useToolCallStore.getState().resolveToolCall(READ_CALL.id)
      ])

      expect(listToolAnswers(backend)).toEqual([
        buildSentAnswer(ALLOWED_APPROVAL)
      ])
    })

    it("runs a call once when its run request arrives twice", async () => {
      const read = createControlledPromise<unknown>()
      const host = startNativeHostFake({ read_text_file: () => read.promise })
      const { backend, replyStreams } = startReplyBackend(
        buildAcceptingToolCallRoutes(READ_CALL)
      )
      const { useToolCallStore } = await loadFreshToolCallStore()
      const stream = await startFollowWithEvents(
        useToolCallStore,
        replyStreams,
        [buildStreamingSnapshot([], [READ_CALL])]
      )

      stream.sendEvent(buildRunEvent(READ_CALL))
      await waitForMicrotasks()
      read.resolve("Buy milk.")
      await waitForMicrotasks()

      expect(host.commands).toHaveLength(1)
      expect(listToolAnswers(backend)).toEqual([buildSentAnswer(READ_RESULT)])
    })

    it("does not send the result of a tool that finishes after its reply ended", async () => {
      const read = createControlledPromise<unknown>()
      startNativeHostFake({ read_text_file: () => read.promise })
      const { backend, replyStreams } = startReplyBackend()
      const { useToolCallStore } = await loadFreshToolCallStore()
      const stream = await startFollowWithEvents(
        useToolCallStore,
        replyStreams,
        [buildStreamingSnapshot(), buildRunEvent(READ_CALL)]
      )

      stream.sendEvent({ type: "interrupted" })
      await waitForMicrotasks()
      read.resolve("Buy milk.")
      await waitForMicrotasks()

      expect(listToolAnswers(backend)).toEqual([])
      expect(useToolCallStore.getState().heldCalls).toEqual([])
    })

    it("sends one result when a call sent to run arrives again after its follow ended", async () => {
      const reads = [
        createControlledPromise<unknown>(),
        createControlledPromise<unknown>()
      ]
      const host = startNativeHostFake({
        read_text_file: () => reads[host.commands.length - 1]?.promise
      })
      const { backend, replyStreams } = startInterruptedReplyBackend(
        buildAcceptingToolCallRoutes(READ_CALL)
      )
      const { useToolCallStore } = await loadFreshToolCallStore()
      const firstStream = await startFollowWithEvents(
        useToolCallStore,
        replyStreams,
        [buildStreamingSnapshot(), buildRunEvent(READ_CALL)]
      )
      await startFollowAfterStreamFailure(
        useToolCallStore,
        firstStream,
        buildStreamingSnapshot([], [READ_CALL]),
        replyStreams
      )

      reads[0]?.resolve("Buy milk.")
      await waitForMicrotasks()
      reads[1]?.resolve("Buy milk.")
      await waitForMicrotasks()

      expect(host.commands).toHaveLength(2)
      expect(listToolAnswers(backend)).toEqual([buildSentAnswer(READ_RESULT)])
      expect(useToolCallStore.getState().heldCalls).toMatchObject([
        { call: READ_CALL, answer: { status: "answered" } }
      ])
    })
  })

  describe("rejectToolCall", () => {
    it.each([
      ["", "The person declined this call."],
      [
        "  wrong folder ",
        "The person declined this call. They said: wrong folder"
      ]
    ])(
      "sends the rejection with the reason %o and runs nothing",
      async (note, content) => {
        const host = startNativeHostFake({})
        const { backend, replyStreams } = startReplyBackend(
          buildAcceptingToolCallRoutes(READ_CALL)
        )
        const { useToolCallStore } = await loadFreshToolCallStore()
        await startFollowWithEvents(useToolCallStore, replyStreams, [
          buildStreamingSnapshot(),
          buildApprovalEvent(READ_CALL)
        ])

        await useToolCallStore.getState().rejectToolCall(READ_CALL.id, note)

        expect(listToolAnswers(backend)).toEqual([
          buildSentAnswer({ status: "rejected", reason: "declined", content })
        ])
        expect(host.commands).toEqual([])
        expect(useToolCallStore.getState().heldCalls).toMatchObject([
          { answer: { status: "answered" } }
        ])
      }
    )

    it("marks the call answered when the backend no longer waits for it", async () => {
      const { replyStreams } = startReplyBackend({
        [buildToolApprovalRouteKey(READ_CALL)]: () =>
          buildJsonResponse(
            409,
            {
              type: "urn:lys:problem:chat:tool-call-not-pending",
              title: "Tool call not pending",
              status: 409,
              detail: "No tool call is waiting under this identifier."
            },
            "application/problem+json"
          )
      })
      const { useToolCallStore } = await loadFreshToolCallStore()
      await startFollowWithEvents(useToolCallStore, replyStreams, [
        buildStreamingSnapshot(),
        buildApprovalEvent(READ_CALL)
      ])

      await useToolCallStore.getState().rejectToolCall(READ_CALL.id, "")

      expect(useToolCallStore.getState().heldCalls).toMatchObject([
        { answer: { status: "answered" } }
      ])
    })

    it("rejects with a store listener's failure after the backend took the rejection, instead of showing it as unsent", async () => {
      const { replyStreams } = startReplyBackend(
        buildAcceptingToolCallRoutes(READ_CALL)
      )
      const { useToolCallStore } = await loadFreshToolCallStore()
      await startFollowWithEvents(useToolCallStore, replyStreams, [
        buildStreamingSnapshot(),
        buildApprovalEvent(READ_CALL)
      ])
      const unsubscribe = useToolCallStore.subscribe(
        handleAnsweredToolCallStateChange
      )

      const rejection = useToolCallStore
        .getState()
        .rejectToolCall(READ_CALL.id, "")

      await expect(rejection).rejects.toBe(LISTENER_FAILURE)
      unsubscribe()
      expect(useToolCallStore.getState().heldCalls).toMatchObject([
        { answer: { status: "answered" } }
      ])
    })
  })

  describe("an answer that cannot be sent", () => {
    it.each([
      [
        "the backend cannot be reached",
        () => Promise.reject(createTransportFailure()),
        "Couldn't send the answer to Lys: The backend could not be reached."
      ],
      [
        "the backend refuses it",
        () => new Response(null, { status: 500 }),
        "Couldn't send the answer to Lys: The backend did not accept the approval (HTTP 500)."
      ]
    ])(
      "keeps the answer and shows the reason when %s",
      async (_label, approvalRoute, error) => {
        const { replyStreams } = startReplyBackend({
          [buildToolApprovalRouteKey(READ_CALL)]: approvalRoute
        })
        const { useToolCallStore } = await loadFreshToolCallStore()
        await startFollowWithEvents(useToolCallStore, replyStreams, [
          buildStreamingSnapshot(),
          buildApprovalEvent(READ_CALL)
        ])

        await useToolCallStore.getState().rejectToolCall(READ_CALL.id, "")

        const state = useToolCallStore.getState()
        expect(state.heldCalls).toMatchObject([
          {
            call: READ_CALL,
            answer: {
              status: "send-failed",
              toolAnswer: DECLINED_APPROVAL,
              error
            }
          }
        ])
        expect(findShownToolCall(state, REPLY_TARGET.conversationId)).toBe(
          state.heldCalls[0]
        )
      }
    )

    it("is sent again on request, without running the tool again", async () => {
      const host = startNativeHostFake({ read_text_file: () => "Buy milk." })
      const toolResult = createControlledRoute()
      const { backend, replyStreams } = startReplyBackend({
        [buildToolResultRouteKey(READ_CALL)]: toolResult.route
      })
      const { useToolCallStore } = await loadFreshToolCallStore()
      await startFollowWithEvents(useToolCallStore, replyStreams, [
        buildStreamingSnapshot(),
        buildRunEvent(READ_CALL)
      ])
      toolResult.responses[0]?.reject(createTransportFailure())
      await waitForMicrotasks()
      const afterFailure = useToolCallStore.getState()

      const retry = useToolCallStore
        .getState()
        .sendUnsentToolCallAnswer(READ_CALL.id)
      await waitForMicrotasks()
      const whileRetrying = useToolCallStore.getState().heldCalls
      toolResult.responses[1]?.resolve(
        new Response(null, { status: ACCEPTED_STATUS })
      )
      await retry

      expect(
        findShownToolCall(afterFailure, REPLY_TARGET.conversationId)?.call
      ).toEqual(READ_CALL)
      expect(whileRetrying).toMatchObject([
        { answer: { status: "sending", toolAnswer: READ_RESULT } }
      ])
      expect(listToolAnswers(backend)).toEqual([
        buildSentAnswer(READ_RESULT),
        buildSentAnswer(READ_RESULT)
      ])
      expect(host.commands).toHaveLength(1)
      expect(useToolCallStore.getState().heldCalls).toMatchObject([
        { answer: { status: "answered" } }
      ])
    })

    it("stays unsent when sending it again fails too", async () => {
      const { backend, replyStreams } = startReplyBackend({
        [buildToolApprovalRouteKey(READ_CALL)]: () =>
          Promise.reject(createTransportFailure())
      })
      const { useToolCallStore } = await loadFreshToolCallStore()
      await startFollowWithEvents(useToolCallStore, replyStreams, [
        buildStreamingSnapshot(),
        buildApprovalEvent(READ_CALL)
      ])
      await useToolCallStore.getState().rejectToolCall(READ_CALL.id, "")

      await useToolCallStore.getState().sendUnsentToolCallAnswer(READ_CALL.id)

      expect(listToolAnswers(backend)).toHaveLength(2)
      expect(useToolCallStore.getState().heldCalls).toMatchObject([
        { answer: { status: "send-failed", toolAnswer: DECLINED_APPROVAL } }
      ])
    })

    it("leaves a prompt that waits again alone when the answer sent before its follow ended fails", async () => {
      const approval = createControlledRoute()
      const { replyStreams } = startInterruptedReplyBackend({
        [buildToolApprovalRouteKey(READ_CALL)]: approval.route
      })
      const { useToolCallStore } = await loadFreshToolCallStore()
      const firstStream = await startFollowWithEvents(
        useToolCallStore,
        replyStreams,
        [buildStreamingSnapshot(), buildApprovalEvent(READ_CALL)]
      )
      const rejection = useToolCallStore
        .getState()
        .rejectToolCall(READ_CALL.id, "")
      await startFollowAfterStreamFailure(
        useToolCallStore,
        firstStream,
        buildStreamingSnapshot([READ_CALL]),
        replyStreams
      )

      approval.responses[0]?.reject(createTransportFailure())
      await rejection

      expect(useToolCallStore.getState().heldCalls).toMatchObject([
        { call: READ_CALL, answer: { status: "awaiting-person" } }
      ])
    })
  })

  describe("an action on a call that is not in the state it applies to", () => {
    it("sends nothing for a call the store does not hold", async () => {
      startNativeHostFake({})
      const { backend } = startReplyBackend()
      const { useToolCallStore } = await loadFreshToolCallStore()
      const { resolveToolCall, rejectToolCall, sendUnsentToolCallAnswer } =
        useToolCallStore.getState()

      await Promise.all([
        resolveToolCall(READ_CALL.id),
        rejectToolCall(READ_CALL.id, "late"),
        sendUnsentToolCallAnswer(READ_CALL.id)
      ])

      expect(backend.requests).toEqual([])
    })

    it("neither answers a prompt again nor resends an answer that did not fail", async () => {
      startNativeHostFake({})
      const { backend, replyStreams } = startReplyBackend(
        buildAcceptingToolCallRoutes(READ_CALL)
      )
      const { useToolCallStore } = await loadFreshToolCallStore()
      await startFollowWithEvents(useToolCallStore, replyStreams, [
        buildStreamingSnapshot(),
        buildApprovalEvent(READ_CALL)
      ])
      const { resolveToolCall, rejectToolCall, sendUnsentToolCallAnswer } =
        useToolCallStore.getState()
      await sendUnsentToolCallAnswer(READ_CALL.id)
      const answersBeforeRejection = listToolAnswers(backend).length
      await rejectToolCall(READ_CALL.id, "")

      await Promise.all([
        resolveToolCall(READ_CALL.id),
        rejectToolCall(READ_CALL.id, "again"),
        sendUnsentToolCallAnswer(READ_CALL.id)
      ])

      expect(answersBeforeRejection).toBe(0)
      expect(listToolAnswers(backend)).toEqual([
        buildSentAnswer(DECLINED_APPROVAL)
      ])
    })

    it("neither allows nor rejects a call that is running", async () => {
      const read = createControlledPromise<unknown>()
      startNativeHostFake({ read_text_file: () => read.promise })
      const { backend, replyStreams } = startReplyBackend(
        buildAcceptingToolCallRoutes(READ_CALL)
      )
      const { useToolCallStore } = await loadFreshToolCallStore()
      await startFollowWithEvents(useToolCallStore, replyStreams, [
        buildStreamingSnapshot(),
        buildRunEvent(READ_CALL)
      ])

      await useToolCallStore.getState().resolveToolCall(READ_CALL.id)
      await useToolCallStore.getState().rejectToolCall(READ_CALL.id, "no")
      read.resolve("Buy milk.")
      await waitForMicrotasks()

      expect(listToolAnswers(backend)).toEqual([buildSentAnswer(READ_RESULT)])
    })
  })
})
