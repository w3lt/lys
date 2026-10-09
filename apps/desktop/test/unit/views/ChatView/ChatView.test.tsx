import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import { STARTER_PROMPTS } from "@/app/content"
import { createStoredChatViewConversation } from "@/lib/store/chat-view/conversation-transitions"
import {
  buildJsonResponse,
  startBackendEventStream,
  startBackendFake,
  type BackendEventStream,
  type BackendRoutes
} from "../../support/backendFake"
import {
  buildCompletedAssistantMessage,
  buildConversation,
  buildConversationListPage,
  buildConversationMetadata,
  buildConversationSummary,
  buildStreamingAssistantMessage,
  buildUserMessage,
  createFixtureUuidV7,
  FIXTURE_CONVERSATION_ID
} from "../../support/conversationFixtures"
import {
  updateStoreRuntime,
  READY_RUNTIME
} from "../../support/runtimeFixtures"
import {
  createControlledPromise,
  waitForMicrotasks
} from "../../support/settlement"

/** Route key of the chat request. */
const CHAT_ROUTE = "POST /api/v1/chat"

/** Route key of the history list read. */
const HISTORY_ROUTE = "GET /api/v1/conversations"

/** A stored conversation listed in history. */
const STORED = buildConversation(createFixtureUuidV7(10), "Trip", [
  buildUserMessage(11, "Plan a trip"),
  buildCompletedAssistantMessage(12, "Start with the route.")
])

/** Route key of reading {@link STORED}. */
const STORED_ROUTE = `GET /api/v1/conversations/${STORED.id}`

/** Start event of a turn that creates the fixture conversation. */
const NEW_TURN_EVENT = Object.freeze({
  type: "start-new-conversation-turn",
  conversation: buildConversationMetadata(FIXTURE_CONVERSATION_ID, null),
  userMessage: buildUserMessage(2, STARTER_PROMPTS[0]),
  assistantMessage: buildStreamingAssistantMessage(3, "")
})

/**
 * Loads fresh stores and the chat view, with a ready runtime.
 *
 * @returns The stores and the view component.
 */
async function loadFreshChatView() {
  vi.resetModules()
  const { useLysStore } = await import("@/lib/store")
  const { useChatViewStore } = await import("@/lib/store/chat-view")
  const { useConversationHistoryStore } =
    await import("@/lib/store/conversation-history")
  const { default: ChatView } = await import("@/views/ChatView/ChatView")
  updateStoreRuntime(useLysStore, READY_RUNTIME)
  return { useChatViewStore, useConversationHistoryStore, ChatView }
}

/**
 * Starts a backend that lists {@link STORED}, serves it, and opens a new
 * event stream per chat request.
 *
 * @param routes - Routes replacing or adding to those.
 * @returns The backend observation handle and the opened streams.
 */
function startChatViewBackend(routes: BackendRoutes = {}) {
  const streams: BackendEventStream[] = []
  const backend = startBackendFake({
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
 * Lets pending requests and store updates settle inside a React update scope.
 */
async function waitForRenderedWork(): Promise<void> {
  await act(async () => {
    await waitForMicrotasks()
  })
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
  it("shows the conversation and the composer, and no history while it is closed", async () => {
    const { ChatView } = await loadFreshChatView()

    render(<ChatView atBottom onScrollPositionChange={vi.fn()} />)

    expect(
      screen.getByRole("region", { name: "Conversation" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("textbox", { name: "Message Lys" })
    ).toBeInTheDocument()
    expect(screen.queryByRole("dialog")).toBeNull()
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
        render(<ChatView atBottom onScrollPositionChange={vi.fn()} />)

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
      const { ChatView } = await loadFreshChatView()
      render(<ChatView atBottom onScrollPositionChange={vi.fn()} />)

      expect(sendHistoryShortcut(init)).toBe(true)
      expect(screen.queryByRole("dialog")).toBeNull()
    })

    it("stops listening once the view is removed", async () => {
      const { useConversationHistoryStore, ChatView } =
        await loadFreshChatView()
      const { unmount } = render(
        <ChatView atBottom onScrollPositionChange={vi.fn()} />
      )

      unmount()
      sendHistoryShortcut({ metaKey: true })

      expect(useConversationHistoryStore.getState().visibility.status).toBe(
        "closed"
      )
    })
  })

  describe("transcript position", () => {
    it("keeps the latest messages in view while pinned", async () => {
      const scrollTo = startScrollRecorder()
      const { useChatViewStore, ChatView } = await loadFreshChatView()
      act(() => {
        useChatViewStore.setState({
          conversation: createStoredChatViewConversation(STORED)
        })
      })
      render(<ChatView atBottom onScrollPositionChange={vi.fn()} />)
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
      const scrollTo = startScrollRecorder()
      const { useChatViewStore, ChatView } = await loadFreshChatView()
      act(() => {
        useChatViewStore.setState({
          conversation: createStoredChatViewConversation(STORED)
        })
      })

      render(<ChatView atBottom={false} onScrollPositionChange={vi.fn()} />)

      expect(scrollTo).not.toHaveBeenCalled()
    })

    it("does not scroll an empty conversation", async () => {
      const scrollTo = startScrollRecorder()
      const { ChatView } = await loadFreshChatView()

      render(<ChatView atBottom onScrollPositionChange={vi.fn()} />)

      expect(scrollTo).not.toHaveBeenCalled()
    })

    it.each([
      [119, true],
      [120, false]
    ])(
      "reports whether a scroll leaving %dpx below stays near the bottom",
      async (remainingPx, isNearBottom) => {
        const onScrollPositionChange = vi.fn()
        const { ChatView } = await loadFreshChatView()
        render(
          <ChatView atBottom onScrollPositionChange={onScrollPositionChange} />
        )
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
      const scrollTo = startScrollRecorder()
      const onScrollPositionChange = vi.fn()
      const { useChatViewStore, ChatView } = await loadFreshChatView()
      act(() => {
        useChatViewStore.setState({
          conversation: createStoredChatViewConversation(STORED)
        })
      })
      render(
        <ChatView
          atBottom={false}
          onScrollPositionChange={onScrollPositionChange}
        />
      )
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
      render(
        <ChatView
          atBottom={false}
          onScrollPositionChange={onScrollPositionChange}
        />
      )
      sendHistoryShortcut({ metaKey: true })
      await waitForRenderedWork()
      const user = userEvent.setup()

      await user.click(screen.getByRole("button", { name: /^Trip/ }))
      await waitForRenderedWork()

      expect(useConversationHistoryStore.getState().visibility.status).toBe(
        "closed"
      )
      expect(onScrollPositionChange).toHaveBeenCalledWith(true)
      expect(screen.getByRole("textbox", { name: "Message Lys" })).toHaveFocus()
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
      render(
        <ChatView atBottom onScrollPositionChange={onScrollPositionChange} />
      )
      sendHistoryShortcut({ ctrlKey: true })
      await waitForRenderedWork()
      const user = userEvent.setup()

      await user.click(screen.getByRole("button", { name: "Start a new one" }))

      expect(screen.queryByRole("dialog")).toBeNull()
      expect(
        screen.getByRole("group", { name: "Starter prompts" })
      ).toBeInTheDocument()
      expect(onScrollPositionChange).toHaveBeenCalledWith(true)
      expect(screen.getByRole("textbox", { name: "Message Lys" })).toHaveFocus()
    })
  })

  describe("requests", () => {
    it("sends a starter prompt and announces the reply until it is final", async () => {
      const { backend, streams } = startChatViewBackend()
      const { ChatView } = await loadFreshChatView()
      render(<ChatView atBottom onScrollPositionChange={vi.fn()} />)
      const user = userEvent.setup()
      const region = screen.getByRole("region", { name: "Conversation" })

      await user.click(screen.getByRole("button", { name: STARTER_PROMPTS[0] }))
      await waitForRenderedWork()

      expect(backend.requests.at(-1)?.body).toMatchObject({
        message: STARTER_PROMPTS[0]
      })
      expect(screen.getByText("Lys is generating a reply")).toBeInTheDocument()
      expect(region).toHaveAttribute("aria-busy", "false")

      await act(async () => {
        streams[0]?.sendEvent(NEW_TURN_EVENT)
        streams[0]?.sendEvent({ type: "delta", content: "I am Lys." })
        streams[0]?.sendEvent({ type: "done", finishReason: "stop" })
        await waitForMicrotasks()
      })

      expect(screen.getByText("I am Lys.")).toBeInTheDocument()
      expect(screen.queryByText("Lys is generating a reply")).toBeNull()
      streams[0]?.close()
    })

    it("announces opening a past conversation and marks the region busy until it is read", async () => {
      const stored = createControlledPromise<Response>()
      startChatViewBackend({ [STORED_ROUTE]: () => stored.promise })
      const { useChatViewStore, ChatView } = await loadFreshChatView()
      render(<ChatView atBottom onScrollPositionChange={vi.fn()} />)

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
      const { useChatViewStore, ChatView } = await loadFreshChatView()
      act(() => {
        useChatViewStore.setState({ error: "Chat is unavailable." })
      })

      render(<ChatView atBottom onScrollPositionChange={vi.fn()} />)

      expect(screen.getByText("Chat is unavailable.")).toBeInTheDocument()
    })
  })
})
