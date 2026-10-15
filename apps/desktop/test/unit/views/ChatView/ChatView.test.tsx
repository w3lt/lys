import {
  act,
  fireEvent,
  render,
  screen,
  within,
  type RenderResult
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import {
  CALIGINIA_AGENT_CODE,
  conversationSchema,
  LYSIPTERA_AGENT_CODE,
  type Conversation
} from "@lys/share"
import type { ComponentType } from "react"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import { STARTER_PROMPTS } from "@/app/content"
import { createStoredChatViewConversation } from "@/lib/store/chat-view/conversation-transitions"
import type { ChatViewProps } from "@/views/ChatView/ChatView"
import {
  buildAgentListPage,
  buildBuiltInAgent
} from "../../support/agentFixtures"
import {
  buildJsonResponse,
  startBackendEventStream,
  startBackendFake,
  type BackendEventStream,
  type BackendFake,
  type BackendRoutes,
  type ObservedBackendRequest
} from "../../support/backendFake"
import {
  buildCompletedAssistantMessage,
  buildConversation,
  buildConversationListPage,
  buildConversationMetadata,
  buildConversationSummary,
  buildFragmentPart,
  buildStreamingAssistantMessage,
  buildUserMessage,
  createFixtureUuidV7,
  FIXTURE_CONVERSATION_ID
} from "../../support/conversationFixtures"
import {
  buildUnreachableRuntime,
  updateStoreRuntime,
  READY_RUNTIME,
  type RuntimeArrangement
} from "../../support/runtimeFixtures"
import {
  createControlledPromise,
  waitForMicrotasks
} from "../../support/settlement"
import { waitForRenderedWork } from "../../support/rendering"

/** Route key of the chat request. */
const CHAT_ROUTE = "POST /api/v1/chat"

/** Route key of the history list read. */
const HISTORY_ROUTE = "GET /api/v1/conversations"

/** Path of the agent list the view reads. */
const AGENTS_PATH = "/api/v1/agents"

/**
 * Built-in agents, as the backend ships them: listed on every page of the
 * agent list, Caliginia first.
 */
const BUILT_IN_AGENTS = Object.freeze([
  buildBuiltInAgent(CALIGINIA_AGENT_CODE, {
    name: "Caliginia",
    bio: "Lys's dark side."
  }),
  buildBuiltInAgent(LYSIPTERA_AGENT_CODE, {
    name: "Lysiptera",
    bio: "Lys's light side."
  })
])

/** A stored conversation listed in history. */
const STORED = buildConversation(createFixtureUuidV7(10), "Trip", [
  buildUserMessage(11, "Plan a trip"),
  buildCompletedAssistantMessage(12, "Start with the route.")
])

/** Route key of reading {@link STORED}. */
const STORED_ROUTE = `GET /api/v1/conversations/${STORED.id}`

/**
 * Builds {@link STORED} as answered by another agent.
 *
 * @param agentCode - Code stored with the conversation.
 * @returns The conversation with that code, frozen and validated by the
 * shared schema.
 */
function buildStoredConversationOf(agentCode: string): Conversation {
  return Object.freeze(conversationSchema.parse({ ...STORED, agentCode }))
}

/** Start event of a turn that creates the fixture conversation. */
const NEW_TURN_EVENT = Object.freeze({
  type: "start-new-conversation-turn",
  conversation: buildConversationMetadata(FIXTURE_CONVERSATION_ID, null),
  userMessage: buildUserMessage(2, STARTER_PROMPTS[0]),
  assistantMessage: buildStreamingAssistantMessage(3, "")
})

/** Route key of following the reply that {@link NEW_TURN_EVENT} starts. */
const NEW_TURN_REPLY_EVENTS_ROUTE = `GET /api/v1/chat/${FIXTURE_CONVERSATION_ID}/replies/${NEW_TURN_EVENT.assistantMessage.id}/events`

/**
 * Answers a follow of the reply {@link NEW_TURN_EVENT} starts as the backend
 * does once that reply completed as `I am Lys.`: a snapshot of the completed
 * reply, then the end of the stream.
 *
 * @returns The reply-events response.
 */
function buildCompletedNewTurnReplyEvents(): Response {
  const stream = startBackendEventStream()
  stream.sendEvent({
    type: "reply-snapshot",
    conversationTitle: null,
    assistantMessage: buildCompletedAssistantMessage(3, "I am Lys."),
    sources: [],
    pendingToolCalls: [],
    pendingToolApprovals: []
  })
  stream.close()
  return stream.response
}

/**
 * Loads fresh stores and the chat view, with an arranged runtime.
 *
 * @param runtime - Runtime facts arranged in the application store; defaults
 * to a ready runtime, whose running backend makes the view read the agent
 * list when it appears.
 * @returns The stores and the view component.
 */
async function loadFreshChatView(runtime: RuntimeArrangement = READY_RUNTIME) {
  vi.resetModules()
  const { useLysStore } = await import("@/lib/store")
  const { useChatViewStore } = await import("@/lib/store/chat-view")
  const { useConversationHistoryStore } =
    await import("@/lib/store/conversation-history")
  const { default: ChatView } = await import("@/views/ChatView/ChatView")
  updateStoreRuntime(useLysStore, runtime)
  return {
    useLysStore,
    useChatViewStore,
    useConversationHistoryStore,
    ChatView
  }
}

/**
 * Starts a backend that lists the built-in agents and {@link STORED}, serves
 * {@link STORED}, and opens a new event stream per chat request.
 *
 * @param routes - Routes replacing or adding to those.
 * @returns The backend observation handle and the opened streams.
 */
function startChatViewBackend(routes: BackendRoutes = {}) {
  const streams: BackendEventStream[] = []
  const backend = startBackendFake({
    [`GET ${AGENTS_PATH}`]: () =>
      buildJsonResponse(
        200,
        buildAgentListPage([], { builtInAgents: BUILT_IN_AGENTS })
      ),
    [HISTORY_ROUTE]: () =>
      buildJsonResponse(
        200,
        buildConversationListPage([
          buildConversationSummary(STORED.id, STORED.title, null)
        ])
      ),
    [STORED_ROUTE]: () => buildJsonResponse(200, STORED),
    [CHAT_ROUTE]: () => {
      const stream = startBackendEventStream()
      streams.push(stream)
      return stream.response
    },
    ...routes
  })
  return { backend, streams }
}

/**
 * Lists the agent-list reads the backend received.
 *
 * @param backend - Observation handle of the case's backend.
 * @returns The reads, in arrival order.
 */
function listAgentListRequests(
  backend: BackendFake
): readonly ObservedBackendRequest[] {
  return backend.requests.filter(
    (request) => new URL(request.url).pathname === AGENTS_PATH
  )
}

/**
 * Renders the chat view and lets the agent-list read it starts when it
 * appears settle, so the view names the agent that answers.
 *
 * @param ChatView - Chat view of the case's fresh module graph.
 * @param props - Parent-owned transcript position and its change callback.
 * @returns The rendered tree.
 * @remarks The case's backend must answer the agent list. Cases about the
 * read itself render the view directly.
 */
async function startChatView(
  ChatView: ComponentType<ChatViewProps>,
  props: ChatViewProps
): Promise<RenderResult> {
  const rendered = render(<ChatView {...props} />)
  await waitForRenderedWork()
  return rendered
}

/**
 * Replaces element scrolling, which jsdom lacks, with a recorder.
 *
 * @returns The recorder; each call keeps the options and the element.
 */
function startScrollRecorder() {
  const scrollTo = vi.fn()
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: scrollTo
  })
  onTestFinished(() => {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollTo")
  })
  return scrollTo
}

/**
 * Gets the transcript host, the view's only scrolling element.
 *
 * @returns The host the transcript scrolls in.
 * @remarks The host has no role; its documented test identifier is the only
 * locator for this non-semantic element.
 */
function getTranscriptHost(): HTMLElement {
  return screen.getByTestId("transcript")
}

/**
 * Presses the past-conversations shortcut on the document.
 *
 * @param init - Modifier state and repetition of the press.
 * @returns Whether the press kept its default action.
 */
function sendHistoryShortcut(init: KeyboardEventInit): boolean {
  let isDefaultKept = true
  act(() => {
    isDefaultKept = fireEvent.keyDown(document, { key: "k", ...init })
  })
  return isDefaultKept
}

describe("ChatView", () => {
  it("shows the conversation and the composer named after the agent that answers, and no history while it is closed", async () => {
    const { backend } = startChatViewBackend()
    const { ChatView } = await loadFreshChatView()

    render(<ChatView atBottom onScrollPositionChange={vi.fn()} />)

    // Until the agent list is read, only the selected agent's code is known.
    expect(
      screen.getByRole("textbox", { name: `Message ${CALIGINIA_AGENT_CODE}` })
    ).toBeInTheDocument()

    await waitForRenderedWork()

    expect(listAgentListRequests(backend)).toHaveLength(1)
    expect(
      screen.getByRole("region", { name: "Conversation" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("textbox", { name: "Message Caliginia" })
    ).toBeEnabled()
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("names the agent that answers the shown conversation on its replies and the message field", async () => {
    startChatViewBackend()
    const { useChatViewStore, ChatView } = await loadFreshChatView()
    act(() => {
      useChatViewStore.setState({
        conversation: createStoredChatViewConversation(
          buildStoredConversationOf(LYSIPTERA_AGENT_CODE)
        )
      })
    })

    await startChatView(ChatView, {
      atBottom: true,
      onScrollPositionChange: vi.fn()
    })

    const region = screen.getByRole("region", { name: "Conversation" })
    expect(within(region).getAllByRole("article").at(-1)).toHaveTextContent(
      /^LysipteraStart with the route\.$/
    )
    expect(
      screen.getByRole("textbox", { name: "Message Lysiptera" })
    ).toBeEnabled()
  })

  it("reads the agent list whenever the backend starts running, and only then", async () => {
    const { backend } = startChatViewBackend()
    const { useLysStore, ChatView } = await loadFreshChatView(
      buildUnreachableRuntime("stopped")
    )
    render(<ChatView atBottom onScrollPositionChange={vi.fn()} />)
    await waitForRenderedWork()
    expect(listAgentListRequests(backend)).toHaveLength(0)

    act(() => {
      updateStoreRuntime(useLysStore, READY_RUNTIME)
    })
    await waitForRenderedWork()

    expect(listAgentListRequests(backend)).toHaveLength(1)
    expect(
      screen.getByRole("textbox", { name: "Message Caliginia" })
    ).toBeInTheDocument()

    act(() => {
      updateStoreRuntime(useLysStore, buildUnreachableRuntime("stopped"))
    })
    await waitForRenderedWork()

    // The list read while the backend ran stays shown while it is stopped.
    expect(listAgentListRequests(backend)).toHaveLength(1)
    expect(
      screen.getByRole("textbox", { name: "Message Caliginia" })
    ).toBeInTheDocument()

    act(() => {
      updateStoreRuntime(useLysStore, READY_RUNTIME)
    })
    await waitForRenderedWork()

    expect(listAgentListRequests(backend)).toHaveLength(2)
  })

  describe("the history shortcut", () => {
    it.each([
      ["Command+K", { metaKey: true }],
      ["Control+K", { ctrlKey: true }]
    ])(
      "opens and closes past conversations with %s",
      async (_name, modifier) => {
        startChatViewBackend()
        const { useConversationHistoryStore, ChatView } =
          await loadFreshChatView()
        await startChatView(ChatView, {
          atBottom: true,
          onScrollPositionChange: vi.fn()
        })

        expect(sendHistoryShortcut(modifier)).toBe(false)
        await waitForRenderedWork()
        expect(
          screen.getByRole("dialog", { name: "Past conversations" })
        ).toBeInTheDocument()

        expect(sendHistoryShortcut({ ...modifier, key: "K" })).toBe(false)
        expect(useConversationHistoryStore.getState().visibility.status).toBe(
          "closed"
        )
        expect(screen.queryByRole("dialog")).toBeNull()
      }
    )

    it.each([
      ["with Shift", { metaKey: true, shiftKey: true }],
      ["with Option", { ctrlKey: true, altKey: true }],
      ["from a held key", { metaKey: true, repeat: true }],
      ["while text is composed", { metaKey: true, isComposing: true }],
      ["without a command modifier", {}]
    ])("ignores K %s", async (_case, init) => {
      startChatViewBackend()
      const { ChatView } = await loadFreshChatView()
      await startChatView(ChatView, {
        atBottom: true,
        onScrollPositionChange: vi.fn()
      })

      expect(sendHistoryShortcut(init)).toBe(true)
      expect(screen.queryByRole("dialog")).toBeNull()
    })

    it("stops listening once the view is removed", async () => {
      startChatViewBackend()
      const { useConversationHistoryStore, ChatView } =
        await loadFreshChatView()
      const { unmount } = await startChatView(ChatView, {
        atBottom: true,
        onScrollPositionChange: vi.fn()
      })

      unmount()
      sendHistoryShortcut({ metaKey: true })

      expect(useConversationHistoryStore.getState().visibility.status).toBe(
        "closed"
      )
    })
  })

  describe("transcript position", () => {
    it("keeps the latest messages in view while pinned", async () => {
      startChatViewBackend()
      const scrollTo = startScrollRecorder()
      const { useChatViewStore, ChatView } = await loadFreshChatView()
      act(() => {
        useChatViewStore.setState({
          conversation: createStoredChatViewConversation(STORED)
        })
      })
      await startChatView(ChatView, {
        atBottom: true,
        onScrollPositionChange: vi.fn()
      })
      const host = getTranscriptHost()
      Object.defineProperty(host, "scrollHeight", {
        configurable: true,
        value: 900
      })

      act(() => {
        useChatViewStore.setState({
          conversation: createStoredChatViewConversation(
            buildConversation(STORED.id, STORED.title, [
              ...STORED.messages,
              buildUserMessage(13, "And then?")
            ])
          )
        })
      })

      expect(scrollTo.mock.calls.at(-1)).toEqual([{ top: 900 }])
      expect(scrollTo.mock.contexts.at(-1)).toBe(host)
    })

    it("leaves the position alone while the reader is away from the latest messages", async () => {
      startChatViewBackend()
      const scrollTo = startScrollRecorder()
      const { useChatViewStore, ChatView } = await loadFreshChatView()
      act(() => {
        useChatViewStore.setState({
          conversation: createStoredChatViewConversation(STORED)
        })
      })

      await startChatView(ChatView, {
        atBottom: false,
        onScrollPositionChange: vi.fn()
      })

      expect(scrollTo).not.toHaveBeenCalled()
    })

    it("does not scroll an empty conversation", async () => {
      startChatViewBackend()
      const scrollTo = startScrollRecorder()
      const { ChatView } = await loadFreshChatView()

      await startChatView(ChatView, {
        atBottom: true,
        onScrollPositionChange: vi.fn()
      })

      expect(scrollTo).not.toHaveBeenCalled()
    })

    it.each([
      [119, true],
      [120, false]
    ])(
      "reports whether a scroll leaving %dpx below stays near the bottom",
      async (remainingPx, isNearBottom) => {
        startChatViewBackend()
        const onScrollPositionChange = vi.fn()
        const { ChatView } = await loadFreshChatView()
        await startChatView(ChatView, {
          atBottom: true,
          onScrollPositionChange
        })
        const host = getTranscriptHost()
        Object.defineProperty(host, "scrollHeight", { value: 1000 })
        Object.defineProperty(host, "clientHeight", { value: 400 })
        Object.defineProperty(host, "scrollTop", { value: 600 - remainingPx })

        fireEvent.scroll(host)

        expect(onScrollPositionChange).toHaveBeenCalledExactlyOnceWith(
          isNearBottom
        )
      }
    )

    it("jumps smoothly to the latest messages and pins the transcript", async () => {
      startChatViewBackend()
      const scrollTo = startScrollRecorder()
      const onScrollPositionChange = vi.fn()
      const { useChatViewStore, ChatView } = await loadFreshChatView()
      act(() => {
        useChatViewStore.setState({
          conversation: createStoredChatViewConversation(STORED)
        })
      })
      await startChatView(ChatView, {
        atBottom: false,
        onScrollPositionChange
      })
      Object.defineProperty(getTranscriptHost(), "scrollHeight", { value: 900 })
      const user = userEvent.setup()

      await user.click(screen.getByRole("button", { name: "Jump to latest" }))

      expect(scrollTo).toHaveBeenCalledExactlyOnceWith({
        top: 900,
        behavior: "smooth"
      })
      expect(onScrollPositionChange).toHaveBeenCalledExactlyOnceWith(true)
    })
  })

  describe("history actions", () => {
    it("opens a past conversation: closes history, pins the transcript, focuses the message field, and reads it", async () => {
      const { backend } = startChatViewBackend()
      const onScrollPositionChange = vi.fn()
      const { useConversationHistoryStore, ChatView } =
        await loadFreshChatView()
      await startChatView(ChatView, {
        atBottom: false,
        onScrollPositionChange
      })
      sendHistoryShortcut({ metaKey: true })
      await waitForRenderedWork()
      const user = userEvent.setup()

      await user.click(screen.getByRole("button", { name: /^Trip/ }))
      await waitForRenderedWork()

      expect(useConversationHistoryStore.getState().visibility.status).toBe(
        "closed"
      )
      expect(onScrollPositionChange).toHaveBeenCalledWith(true)
      expect(
        screen.getByRole("textbox", { name: "Message Caliginia" })
      ).toHaveFocus()
      expect(backend.requests.at(-1)?.url).toContain(STORED.id)
      expect(screen.getByText("Start with the route.")).toBeInTheDocument()
    })

    it("starts a new conversation: closes history, clears the shown one, pins, and focuses the field", async () => {
      startChatViewBackend()
      const onScrollPositionChange = vi.fn()
      const { useChatViewStore, ChatView } = await loadFreshChatView()
      act(() => {
        useChatViewStore.setState({
          conversation: createStoredChatViewConversation(STORED)
        })
      })
      await startChatView(ChatView, {
        atBottom: true,
        onScrollPositionChange
      })
      sendHistoryShortcut({ ctrlKey: true })
      await waitForRenderedWork()
      const user = userEvent.setup()

      await user.click(screen.getByRole("button", { name: "Start a new one" }))

      expect(screen.queryByRole("dialog")).toBeNull()
      expect(
        screen.getByRole("group", { name: "Starter prompts" })
      ).toBeInTheDocument()
      expect(onScrollPositionChange).toHaveBeenCalledWith(true)
      expect(
        screen.getByRole("textbox", { name: "Message Caliginia" })
      ).toHaveFocus()
    })

    it("starts a new conversation from the deleted-agent notice: clears the shown one, pins, and focuses the field once it is enabled", async () => {
      startChatViewBackend()
      const onScrollPositionChange = vi.fn()
      const { useChatViewStore, ChatView } = await loadFreshChatView()
      act(() => {
        useChatViewStore.setState({
          conversation: createStoredChatViewConversation(
            buildStoredConversationOf("scout")
          )
        })
      })
      render(
        <ChatView atBottom onScrollPositionChange={onScrollPositionChange} />
      )
      // The composer always offers its own New conversation; once the agent
      // list says the agent was deleted, the notice adds a second one.
      const [composerButton] = screen.getAllByRole("button", {
        name: "New conversation"
      })
      await waitForRenderedWork()
      const noticeButton = screen
        .getAllByRole("button", { name: "New conversation" })
        .find((button) => button !== composerButton)
      if (noticeButton === undefined) {
        throw new Error("The deleted-agent notice offers no new conversation")
      }
      // A deleted agent is known only by the code stored with its replies.
      expect(screen.getAllByRole("article").at(-1)).toHaveTextContent(
        /^scoutStart with the route\.$/
      )
      expect(
        screen.getByRole("textbox", { name: "Message scout" })
      ).toBeDisabled()
      const user = userEvent.setup()

      await user.click(noticeButton)

      expect(
        screen.getByRole("group", { name: "Starter prompts" })
      ).toBeInTheDocument()
      expect(onScrollPositionChange).toHaveBeenCalledWith(true)
      expect(
        screen.getByRole("textbox", { name: "Message Caliginia" })
      ).toHaveFocus()
    })
  })

  describe("requests", () => {
    it("sends a starter prompt to the agent that answers and announces the reply until it is final", async () => {
      const { backend, streams } = startChatViewBackend({
        [NEW_TURN_REPLY_EVENTS_ROUTE]: buildCompletedNewTurnReplyEvents
      })
      const { ChatView } = await loadFreshChatView()
      await startChatView(ChatView, {
        atBottom: true,
        onScrollPositionChange: vi.fn()
      })
      const user = userEvent.setup()
      const region = screen.getByRole("region", { name: "Conversation" })

      await user.click(screen.getByRole("button", { name: STARTER_PROMPTS[0] }))
      await waitForRenderedWork()

      expect(backend.requests.at(-1)?.body).toMatchObject({
        conversation: { kind: "new", agentCode: CALIGINIA_AGENT_CODE },
        message: STARTER_PROMPTS[0]
      })
      expect(
        within(region).getByText("Caliginia is generating a reply")
      ).toBeInTheDocument()
      expect(region).toHaveAttribute("aria-busy", "false")

      const answer = buildFragmentPart("text", 40, 0, "I am Lys.")
      await act(async () => {
        streams[0]?.sendEvent(NEW_TURN_EVENT)
        streams[0]?.sendEvent({ type: "reply-part", part: answer })
        streams[0]?.sendEvent({ type: "done", finishReason: "stop" })
        await waitForMicrotasks()
      })

      expect(screen.getByText("I am Lys.")).toBeInTheDocument()
      expect(screen.queryByText("Caliginia is generating a reply")).toBeNull()
      streams[0]?.close()
    })

    it("announces opening a past conversation and marks the region busy until it is read", async () => {
      const stored = createControlledPromise<Response>()
      startChatViewBackend({ [STORED_ROUTE]: () => stored.promise })
      const { useChatViewStore, ChatView } = await loadFreshChatView()
      await startChatView(ChatView, {
        atBottom: true,
        onScrollPositionChange: vi.fn()
      })

      act(() => {
        void useChatViewStore.getState().openConversation(STORED.id)
      })
      await waitForRenderedWork()

      const region = screen.getByRole("region", { name: "Conversation" })
      expect(screen.getByText("Opening conversation")).toBeInTheDocument()
      expect(region).toHaveAttribute("aria-busy", "true")

      stored.resolve(buildJsonResponse(200, STORED))
      await waitForRenderedWork()

      expect(region).toHaveAttribute("aria-busy", "false")
      expect(screen.getByText("Start with the route.")).toBeInTheDocument()
    })

    it("shows a chat failure in the transcript", async () => {
      startChatViewBackend()
      const { useChatViewStore, ChatView } = await loadFreshChatView()
      act(() => {
        useChatViewStore.setState({ error: "Chat is unavailable." })
      })

      await startChatView(ChatView, {
        atBottom: true,
        onScrollPositionChange: vi.fn()
      })

      expect(screen.getByText("Chat is unavailable.")).toBeInTheDocument()
    })
  })
})
