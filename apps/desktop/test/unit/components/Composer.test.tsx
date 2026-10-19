import { createRef, StrictMode } from "react"
import {
  act,
  createEvent,
  fireEvent,
  render,
  screen,
  within
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { chatReplyEventSchema } from "@lys/protocol"
import {
  CALIGINIA_AGENT_CODE,
  conversationSchema,
  LYSIPTERA_AGENT_CODE,
  type Conversation
} from "@lys/share"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { DELETED_CONVERSATION_AGENT_MESSAGE } from "@/lib/conversation-agent-messages"
import { createStoredChatViewConversation } from "@/lib/store/chat-view/conversation-transitions"
import type { HeldToolCall } from "@/lib/store/tool-calls"
import { buildAgentListPage, buildBuiltInAgent } from "../support/agentFixtures"
import {
  buildJsonResponse,
  createControlledRoute,
  listRouteKeys,
  startBackendEventStream,
  startBackendFake,
  type BackendEventStream,
  type BackendRoutes
} from "../support/backendFake"
import {
  CHAT_CONTEXT_ROUTE,
  FIXTURE_CHAT_CONTEXT_MEASUREMENT,
  listRequestsBesideMeasurements,
  MEASURING_BACKEND_ROUTES
} from "../support/chatContextFixtures"
import {
  buildConversation,
  buildConversationListPage,
  buildConversationMetadata,
  buildFragmentPart,
  buildStreamingAssistantMessage,
  buildUserMessage,
  FIXTURE_CONVERSATION_ID
} from "../support/conversationFixtures"
import { buildLlmInfo } from "../support/modelFixtures"
import { startNativeHostFake } from "../support/nativeHostFake"
import {
  updateStoreRuntime,
  buildUnreachableRuntime,
  READY_RUNTIME,
  type RuntimeArrangement
} from "../support/runtimeFixtures"
import {
  createControlledPromise,
  waitForMicrotasks
} from "../support/settlement"
import { openMenuWithKeyboard, waitForRenderedWork } from "../support/rendering"
import { buildToolCall, buildToolDefinition } from "../support/toolFixtures"

/** Route key of the chat request. */
const CHAT_ROUTE = "POST /api/v1/chat"

/** Route key of the history list read. */
const HISTORY_ROUTE = "GET /api/v1/conversations"

/** Reply the first turn streams. */
const REPLY = buildStreamingAssistantMessage(3, "")

/** Route key of the stop request for {@link REPLY}. */
const STOP_REPLY_ROUTE = `POST /api/v1/chat/${FIXTURE_CONVERSATION_ID}/replies/${REPLY.id}/stop`

/** Route key of following {@link REPLY}, which the tool-call store does. */
const REPLY_EVENTS_ROUTE = `GET /api/v1/chat/${FIXTURE_CONVERSATION_ID}/replies/${REPLY.id}/events`

/**
 * First event of a follow of {@link REPLY} that opens right after its turn
 * started: the reply streams, has no text yet, and no tool call waits.
 */
const REPLY_SNAPSHOT = chatReplyEventSchema.parse({
  type: "reply-snapshot",
  conversationTitle: null,
  assistantMessage: REPLY,
  sources: [],
  pendingToolCalls: [],
  pendingToolApprovals: []
})

/** Start event of a turn that creates the fixture conversation. */
const NEW_TURN_EVENT = Object.freeze({
  type: "start-new-conversation-turn",
  conversation: buildConversationMetadata(FIXTURE_CONVERSATION_ID, null),
  userMessage: buildUserMessage(2, "Hello"),
  assistantMessage: REPLY
})

/**
 * Agent list page of a backend that ships Caliginia and Lysiptera and stores
 * none of the user's own agents.
 */
const BUILT_IN_AGENT_PAGE = buildAgentListPage([], {
  builtInAgents: [
    buildBuiltInAgent(CALIGINIA_AGENT_CODE, { name: "Caliginia" }),
    buildBuiltInAgent(LYSIPTERA_AGENT_CODE, { name: "Lysiptera" })
  ]
})

/** Call of {@link REPLY} that reads the fixture notes. */
const READ_CALL = buildToolCall(10, "read_text_file")

/** Route key of the tool-approval endpoint for {@link READ_CALL}. */
const READ_APPROVAL_ROUTE = `POST /api/v1/chat/${FIXTURE_CONVERSATION_ID}/replies/${REPLY.id}/tool-approvals/${READ_CALL.id}`

/** {@link READ_CALL} as the tool-call store holds it while it asks first. */
const WAITING_READ: HeldToolCall = Object.freeze({
  target: Object.freeze({
    conversationId: FIXTURE_CONVERSATION_ID,
    assistantMessageId: REPLY.id,
    callId: READ_CALL.id
  }),
  call: READ_CALL,
  step: "approval",
  answer: Object.freeze({
    status: "awaiting-person",
    definition: buildToolDefinition("read_text_file"),
    input: Object.freeze({
      runner: "client",
      toolName: "read_text_file",
      input: Object.freeze({ path: "/notes/todo.md" })
    })
  })
})

/** Code of a stored agent the user deleted after talking to it. */
const DELETED_AGENT_CODE = "web-researcher"

/**
 * Pasted passage of 1,319 characters, long enough for the composer to divert
 * it from the draft (1,200 or more). It has no whitespace at either end and
 * no character JSON escapes, so a request carrying it contains it verbatim.
 */
const LONG_PASTE = Array.from(
  { length: 60 },
  () => "a long pasted passage"
).join(" ")

/** Content of a file the user attaches; no character in it is escaped. */
const NOTES_CONTENT = "Renew the passport before March."

/**
 * Loads fresh application, chat-view, history, and agent stores with the
 * composer that reads them, and arranges the runtime the case needs.
 *
 * @param runtime - Backend, LM Studio, and model facts; the residency is
 * derived from them as the application store derives it.
 * @returns The stores and the composer component.
 * @remarks The agent list holds {@link BUILT_IN_AGENT_PAGE}, as the chat
 * view's read leaves it once the backend runs; the composer reads the list
 * but never starts a read itself.
 */
async function loadFreshComposer(runtime: RuntimeArrangement = READY_RUNTIME) {
  vi.resetModules()
  const { useLysStore } = await import("@/lib/store")
  const { useChatViewStore } = await import("@/lib/store/chat-view")
  const { useConversationHistoryStore } =
    await import("@/lib/store/conversation-history")
  const { useAgentStore } = await import("@/lib/store/agents")
  const { Composer } = await import("@/components/Composer")
  updateStoreRuntime(useLysStore, runtime)
  useAgentStore.setState({
    list: {
      status: "loaded",
      builtInAgents: BUILT_IN_AGENT_PAGE.builtInAgents,
      agents: BUILT_IN_AGENT_PAGE.agents,
      isRefreshing: false
    }
  })
  return {
    useLysStore,
    useChatViewStore,
    useConversationHistoryStore,
    Composer
  }
}

/**
 * Loads a fresh composer whose shown conversation has a reply that waits for
 * the person to answer {@link READ_CALL}.
 *
 * @returns The stores and the composer component of {@link loadFreshComposer}.
 * @remarks The tool-call store is the one the composer reads, loaded with
 * it; it holds the call as it does once the reply's follow delivered it.
 */
async function loadFreshComposerWithWaitingCall() {
  const loaded = await loadFreshComposer()
  const { useToolCallStore } = await import("@/lib/store/tool-calls")
  loaded.useChatViewStore.setState({
    conversation: createStoredChatViewConversation(
      buildConversation(FIXTURE_CONVERSATION_ID, null, [
        buildUserMessage(2, "Read my notes"),
        REPLY
      ])
    )
  })
  useToolCallStore.setState({ heldCalls: [WAITING_READ] })
  return loaded
}

/**
 * Builds a stored conversation answered by {@link DELETED_AGENT_CODE}, which
 * {@link BUILT_IN_AGENT_PAGE} no longer lists.
 *
 * @returns A frozen conversation validated by the shared schema.
 */
function buildDeletedAgentConversation(): Conversation {
  return Object.freeze(
    conversationSchema.parse({
      ...buildConversation(FIXTURE_CONVERSATION_ID, "Research", [
        buildUserMessage(2, "Hello")
      ]),
      agentCode: DELETED_AGENT_CODE
    })
  )
}

/** Streams a chat backend opened, by the connection that reads them. */
type ChatBackendStreams = Readonly<{
  /** Stream of each chat request, in order. */
  streams: readonly BackendEventStream[]
  /** Stream of each follow of {@link REPLY}, in order. */
  replyFollows: readonly BackendEventStream[]
}>

/**
 * Starts a backend whose chat route opens a new event stream per request,
 * and whose reply-events route answers the tool-call store's follow of
 * {@link REPLY}.
 *
 * @param routes - Other routes the case needs.
 * @returns The backend observation handle and the opened streams in order.
 * @remarks Each follow opens with {@link REPLY_SNAPSHOT} and stays open; a
 * case sends the reply's later events to it with {@link sendReplyEvents}.
 */
function startChatBackend(routes: BackendRoutes = {}) {
  const streams: BackendEventStream[] = []
  const replyFollows: BackendEventStream[] = []
  const backend = startBackendFake({
    ...MEASURING_BACKEND_ROUTES,
    [CHAT_ROUTE]: () => {
      const stream = startBackendEventStream()
      streams.push(stream)
      return stream.response
    },
    [REPLY_EVENTS_ROUTE]: () => {
      const follow = startBackendEventStream()
      follow.sendEvent(REPLY_SNAPSHOT)
      replyFollows.push(follow)
      return follow.response
    },
    ...routes
  })
  return { backend, streams, replyFollows }
}

/**
 * Lists the bodies of the chat requests a backend received.
 *
 * @param backend - Backend observation handle.
 * @returns Each chat request body, in order.
 */
function listChatBodies(backend: ReturnType<typeof startBackendFake>) {
  return backend.requests
    .filter((request) => request.method === "POST")
    .filter((request) => new URL(request.url).pathname === "/api/v1/chat")
    .map((request) => request.body)
}

/**
 * Tells whether a chat request body carries a text.
 *
 * @param body - JSON-decoded chat request body.
 * @param text - Text without characters JSON escapes, such as
 * {@link LONG_PASTE} or {@link NOTES_CONTENT}.
 * @returns Whether the serialized body contains the text as written or
 * base64-encoded, the two forms in which a JSON body can carry a file's
 * content; the request contract does not fix which one an attachment uses.
 */
function isTextInChatBody(body: unknown, text: string): boolean {
  const serializedBody = JSON.stringify(body)
  return serializedBody.includes(text) || serializedBody.includes(btoa(text))
}

/**
 * Lists the route keys of the requests a backend received, in order, other
 * than the tool-call store's follows of {@link REPLY} and the composer's
 * context measurements.
 *
 * @param backend - Backend observation handle.
 * @returns `<METHOD> <path>` of each request except a follow or a
 * measurement, which run in no order the composer's sending fixes.
 */
function listRouteKeysWithoutReplyFollows(
  backend: ReturnType<typeof startBackendFake>
) {
  return listRouteKeys(backend).filter(
    (routeKey) =>
      routeKey !== REPLY_EVENTS_ROUTE && routeKey !== CHAT_CONTEXT_ROUTE
  )
}

/**
 * Sends events on a stream and waits until the composer shows their effect.
 *
 * @param stream - Stream the backend writes.
 * @param events - Event payloads in sending order.
 */
async function sendStreamEvents(
  stream: BackendEventStream | undefined,
  ...events: unknown[]
): Promise<void> {
  await act(async () => {
    events.forEach((event) => stream?.sendEvent(event))
    await waitForMicrotasks()
  })
}

/**
 * Sends live events of {@link REPLY} on every chat stream and every follow,
 * as the backend sends a reply's events to each connection that reads it,
 * and waits until the composer shows their effect.
 *
 * @param chatStreams - Streams of the chat backend of the case.
 * @param events - Live reply events in sending order.
 * @throws When the tool-call store follows no reply yet; the events would
 * then never end its follow.
 */
async function sendReplyEvents(
  chatStreams: ChatBackendStreams,
  ...events: unknown[]
): Promise<void> {
  if (chatStreams.replyFollows.length === 0) {
    throw new Error("The tool-call store follows no reply")
  }
  await act(async () => {
    const readers = [...chatStreams.streams, ...chatStreams.replyFollows]
    events.forEach((event) =>
      readers.forEach((reader) => reader.sendEvent(event))
    )
    await waitForMicrotasks()
  })
}

/**
 * Gets the message field of a composer whose answering agent is Caliginia,
 * the agent a new conversation starts with.
 *
 * @returns The composer's textarea, named after the agent.
 * @throws When no single field is named after Caliginia.
 */
function getMessageField(): HTMLElement {
  return screen.getByRole("textbox", { name: "Message Caliginia" })
}

/**
 * Lists the text of every status region the composer renders.
 *
 * @returns Each region's text in document order; an empty region, which
 * waits for an announcement, gives an empty string.
 */
function listStatusTexts(): string[] {
  return screen.getAllByRole("status").map((status) => status.textContent ?? "")
}

/**
 * Gets the hidden file input the attach action opens.
 *
 * @param container - Rendered container.
 * @returns The file input; it has no accessible name, because the plus menu
 * is its user-facing control.
 */
function getFileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')
  if (input === null) throw new Error("The composer has no file input")
  return input
}

/**
 * Finds which of the given file names a staged chip shows.
 *
 * @param chip - List item of one staged file.
 * @param fileNames - Names the case staged.
 * @returns The first of `fileNames` the chip shows as its whole name text,
 * or `undefined` when it shows none of them.
 */
function findChipName(
  chip: HTMLElement,
  fileNames: readonly string[]
): string | undefined {
  return fileNames.find((name) => within(chip).queryByText(name) !== null)
}

/**
 * Lists the staged chips by the file name each one shows.
 *
 * @param fileNames - Names the case staged.
 * @returns For each chip in tray order, the name it shows, or `undefined`
 * for a chip that shows none of `fileNames`; empty while no tray is shown.
 */
function listStagedNames(fileNames: readonly string[]): (string | undefined)[] {
  const tray = screen.queryByRole("list", { name: "Attached to this message" })
  if (tray === null) return []
  return within(tray)
    .getAllByRole("listitem")
    .map((chip) => findChipName(chip, fileNames))
}

/**
 * Drops files on an element the way a browser exposes them.
 *
 * @param target - Element the files are released over.
 * @param files - Released files.
 * @remarks jsdom has no drag data store. A browser lets the drop listeners
 * read the files only while the event is dispatched; afterwards the event's
 * file list is empty. The event built here does the same.
 */
function sendFileDrop(target: Element, files: readonly File[]): void {
  const drop = createEvent.drop(target)
  Object.defineProperty(drop, "dataTransfer", {
    value: {
      get files() {
        return drop.eventPhase === Event.NONE ? [] : files
      }
    }
  })
  fireEvent(target, drop)
}

describe("Composer", () => {
  // A ready composer measures what its next message would be sent with.
  beforeEach(() => {
    startBackendFake(MEASURING_BACKEND_ROUTES)
  })

  describe("drafting and sending", () => {
    it("keeps Send disabled until the draft has text, which the chat store owns", async () => {
      const { useChatViewStore, Composer } = await loadFreshComposer()
      const user = userEvent.setup()
      render(
        <Composer messageFieldRef={createRef()} onStartConversation={vi.fn()} />
      )

      const field = getMessageField()
      expect(field).toHaveAttribute("placeholder", "Say something to Caliginia")
      expect(screen.getByRole("button", { name: "Send" })).toBeDisabled()

      await user.type(field, "   ")
      expect(screen.getByRole("button", { name: "Send" })).toBeDisabled()

      await user.type(field, "Hello")
      expect(screen.getByRole("button", { name: "Send" })).toBeEnabled()
      expect(useChatViewStore.getState().inputDraft).toBe("   Hello")
    })

    it("attaches the parent's ref to the message field", async () => {
      const { Composer } = await loadFreshComposer()
      const messageFieldRef = createRef<HTMLTextAreaElement>()

      render(
        <Composer
          messageFieldRef={messageFieldRef}
          onStartConversation={vi.fn()}
        />
      )

      expect(messageFieldRef.current).toBe(getMessageField())
    })

    it("sends the draft once on Enter with the loaded model and saved generation settings", async () => {
      const { backend, streams } = startChatBackend()
      const { useLysStore, Composer } = await loadFreshComposer()
      const { generation } = useLysStore.getState().settings
      const user = userEvent.setup()
      render(
        <Composer messageFieldRef={createRef()} onStartConversation={vi.fn()} />
      )

      await user.type(getMessageField(), "Hello{Enter}")
      await waitForRenderedWork()

      expect(listChatBodies(backend)).toEqual([
        {
          conversation: { kind: "new", agentCode: CALIGINIA_AGENT_CODE },
          message: "Hello",
          model: "qwen3-8b",
          generationOptions: generation
        }
      ])
      streams[0]?.close()
    })

    it("adds a line on Shift+Enter without sending", async () => {
      const { backend } = startChatBackend()
      const { Composer } = await loadFreshComposer()
      const user = userEvent.setup()
      render(
        <Composer messageFieldRef={createRef()} onStartConversation={vi.fn()} />
      )

      await user.type(getMessageField(), "Hello{Shift>}{Enter}{/Shift}there")
      await waitForRenderedWork()

      expect(getMessageField()).toHaveValue("Hello\nthere")
      expect(listRequestsBesideMeasurements(backend)).toEqual([])
    })

    it("neither sends nor adds a line on Enter with a blank draft", async () => {
      const { backend } = startChatBackend()
      const { Composer } = await loadFreshComposer()
      const user = userEvent.setup()
      render(
        <Composer messageFieldRef={createRef()} onStartConversation={vi.fn()} />
      )

      await user.type(getMessageField(), "  {Enter}")
      await waitForRenderedWork()

      expect(getMessageField()).toHaveValue("  ")
      expect(listRequestsBesideMeasurements(backend)).toEqual([])
    })

    it("sends the draft when Send is pressed", async () => {
      const { backend, streams } = startChatBackend()
      const { Composer } = await loadFreshComposer()
      const user = userEvent.setup()
      render(
        <Composer messageFieldRef={createRef()} onStartConversation={vi.fn()} />
      )
      await user.type(getMessageField(), "Hello")

      await user.click(screen.getByRole("button", { name: "Send" }))
      await waitForRenderedWork()

      expect(listChatBodies(backend)).toHaveLength(1)
      streams[0]?.close()
    })

    it("keeps a short paste in the draft", async () => {
      const { Composer } = await loadFreshComposer()
      const user = userEvent.setup()
      render(
        <Composer messageFieldRef={createRef()} onStartConversation={vi.fn()} />
      )
      await user.click(getMessageField())

      await user.paste("short pasted text")

      expect(getMessageField()).toHaveValue("short pasted text")
      expect(
        screen.queryByRole("list", { name: "Attached to this message" })
      ).toBeNull()
    })

    // Known defect (#168): the field answers Enter while an input method is
    // still composing text, so the Enter that confirms a composition sends
    // the unfinished draft. The other key handlers of the renderer leave such
    // keys to the input method.
    it.fails(
      "leaves an Enter that belongs to text composition to the input method",
      async () => {
        const { backend, streams } = startChatBackend()
        const { useChatViewStore, Composer } = await loadFreshComposer()
        useChatViewStore.setState({ inputDraft: "Konnichi" })
        render(
          <Composer
            messageFieldRef={createRef()}
            onStartConversation={vi.fn()}
          />
        )

        fireEvent.keyDown(getMessageField(), {
          key: "Enter",
          isComposing: true
        })
        await waitForRenderedWork()
        streams[0]?.close()

        expect(listChatBodies(backend)).toEqual([])
      }
    )

    // Known defect, tracked by #27 and #105: a paste of 1,200 characters or
    // more leaves the draft for a tray entry that keeps only its length, so
    // the chat request carries none of the pasted text. Either fix sends it:
    // #27 keeps it in the draft, #105 sends it as an attachment.
    it.fails(
      "sends the text of a long paste with the message (#27, #105)",
      async () => {
        const { backend, streams } = startChatBackend()
        const { Composer } = await loadFreshComposer()
        const user = userEvent.setup()
        render(
          <Composer
            messageFieldRef={createRef()}
            onStartConversation={vi.fn()}
          />
        )
        await user.type(getMessageField(), "Summarize this: ")

        await user.paste(LONG_PASTE)
        await user.keyboard("{Enter}")
        await waitForRenderedWork()

        expect(
          listChatBodies(backend).map((body) =>
            isTextInChatBody(body, LONG_PASTE)
          ),
          "whether each chat request carries the pasted text"
        ).toEqual([true])
        streams[0]?.close()
      }
    )
  })

  describe("request phases", () => {
    it("offers Stop while the turn is awaited, and stops the reply once it is known", async () => {
      const { backend, streams, replyFollows } = startChatBackend({
        [STOP_REPLY_ROUTE]: () => new Response(null, { status: 204 })
      })
      const { Composer } = await loadFreshComposer()
      const user = userEvent.setup()
      render(
        <Composer messageFieldRef={createRef()} onStartConversation={vi.fn()} />
      )
      await user.type(getMessageField(), "Hello{Enter}")
      await waitForRenderedWork()

      expect(screen.queryByRole("button", { name: "Send" })).toBeNull()
      expect(screen.getByText("Generating…")).toBeInTheDocument()
      await user.click(screen.getByRole("button", { name: "Stop reply" }))
      await waitForRenderedWork()
      expect(listRouteKeysWithoutReplyFollows(backend)).toEqual([CHAT_ROUTE])

      await sendStreamEvents(streams[0], NEW_TURN_EVENT)

      expect(listRouteKeysWithoutReplyFollows(backend)).toEqual([
        CHAT_ROUTE,
        STOP_REPLY_ROUTE
      ])
      await sendReplyEvents({ streams, replyFollows }, { type: "interrupted" })
      streams[0]?.close()
    })

    it("asks the backend to stop a streaming reply and keeps the draft typed meanwhile", async () => {
      const { backend, streams, replyFollows } = startChatBackend({
        [STOP_REPLY_ROUTE]: () => new Response(null, { status: 204 })
      })
      const { Composer } = await loadFreshComposer()
      const user = userEvent.setup()
      render(
        <Composer messageFieldRef={createRef()} onStartConversation={vi.fn()} />
      )
      await user.type(getMessageField(), "Hello{Enter}")
      await waitForRenderedWork()
      await sendStreamEvents(streams[0], NEW_TURN_EVENT)
      await sendReplyEvents(
        { streams, replyFollows },
        { type: "reply-part", part: buildFragmentPart("text", 40, 0, "Hi") }
      )
      expect(getMessageField()).toHaveValue("")

      await user.type(getMessageField(), "Next question")
      await user.click(screen.getByRole("button", { name: "Stop reply" }))
      await waitForRenderedWork()
      await sendReplyEvents({ streams, replyFollows }, { type: "interrupted" })

      expect(listRouteKeysWithoutReplyFollows(backend)).toEqual([
        CHAT_ROUTE,
        STOP_REPLY_ROUTE
      ])
      expect(getMessageField()).toHaveValue("Next question")
      expect(screen.getByRole("button", { name: "Send" })).toBeEnabled()
      streams[0]?.close()
    })

    it("offers Send once the reply is final, while its stream may still carry a title", async () => {
      const { streams, replyFollows } = startChatBackend()
      const { Composer } = await loadFreshComposer()
      const user = userEvent.setup()
      render(
        <Composer messageFieldRef={createRef()} onStartConversation={vi.fn()} />
      )
      await user.type(getMessageField(), "Hello{Enter}")
      await waitForRenderedWork()

      await sendStreamEvents(streams[0], NEW_TURN_EVENT)
      await sendReplyEvents(
        { streams, replyFollows },
        { type: "reply-part", part: buildFragmentPart("text", 40, 0, "Hi") },
        { type: "done", finishReason: "stop" }
      )
      await user.type(getMessageField(), "Thanks")

      expect(screen.queryByRole("button", { name: "Stop reply" })).toBeNull()
      expect(screen.getByRole("button", { name: "Send" })).toBeEnabled()
      expect(screen.queryByText("Generating…")).toBeNull()
      streams[0]?.close()
    })

    it("refuses to send while a past conversation opens", async () => {
      const { useChatViewStore, Composer } = await loadFreshComposer()
      useChatViewStore.setState({
        inputDraft: "",
        conversationOpen: {
          status: "opening",
          conversationId: FIXTURE_CONVERSATION_ID,
          replacedComposerDraft: ""
        }
      })
      const user = userEvent.setup()
      render(
        <Composer messageFieldRef={createRef()} onStartConversation={vi.fn()} />
      )

      expect(getMessageField()).toHaveAttribute(
        "placeholder",
        "Opening a past conversation…"
      )
      expect(screen.getByText("Opening…")).toBeInTheDocument()
      await user.type(getMessageField(), "Hello{Enter}")
      expect(screen.getByRole("button", { name: "Send" })).toBeDisabled()
    })
  })

  describe("unavailable generation", () => {
    it("names a stopped backend, disables composing, and starts it on request", async () => {
      const start = createControlledPromise<unknown>()
      const host = startNativeHostFake({
        get_backend_status: () => ({ running: false }),
        start_backend: () => start.promise
      })
      const { useLysStore, Composer } = await loadFreshComposer(
        buildUnreachableRuntime("stopped")
      )
      const { backendAddress } = useLysStore.getState().settings.runtime
      const user = userEvent.setup()
      render(
        <Composer messageFieldRef={createRef()} onStartConversation={vi.fn()} />
      )

      expect(listStatusTexts()).toContainEqual(
        expect.stringContaining(
          `The backend is not running on ${backendAddress}.`
        )
      )
      expect(getMessageField()).toBeDisabled()
      expect(getMessageField()).toHaveAttribute(
        "placeholder",
        "Waiting on the backend…"
      )
      expect(
        screen.getByRole("button", { name: "Add to this message" })
      ).toBeDisabled()
      expect(
        screen.queryByRole("button", { name: /^Context window/ })
      ).toBeNull()

      await user.click(screen.getByRole("button", { name: "Start backend" }))
      await waitForRenderedWork()

      expect(host.commands.map((invoked) => invoked.command)).toEqual([
        "get_backend_status",
        "start_backend"
      ])
      expect(listStatusTexts()).toContainEqual(
        expect.stringContaining(`Starting the backend on ${backendAddress}…`)
      )
      expect(screen.getByRole("button", { name: "Working" })).toBeDisabled()

      start.resolve({ running: false })
      await waitForRenderedWork()
    })

    it.each([
      [
        "LM Studio is not reachable",
        buildUnreachableRuntime("running", "unreachable"),
        "Check LM Studio",
        "runtime"
      ],
      [
        "no model is loaded",
        {
          ...READY_RUNTIME,
          defaultModel: null,
          modelInventory: {
            status: "ready",
            models: [buildLlmInfo("qwen3-8b")]
          }
        },
        "Load model",
        "model"
      ],
      [
        "the model state is unknown",
        { ...READY_RUNTIME, modelInventory: { status: "failed" } },
        "Check models",
        "model"
      ]
    ] as const)(
      "opens the settings pane that fixes it when %s",
      async (_case, runtime, actionLabel, pane) => {
        const { useLysStore, Composer } = await loadFreshComposer(runtime)
        const user = userEvent.setup()
        render(
          <Composer
            messageFieldRef={createRef()}
            onStartConversation={vi.fn()}
          />
        )

        expect(getMessageField()).toHaveAttribute(
          "placeholder",
          "Waiting on LM Studio…"
        )
        await user.click(screen.getByRole("button", { name: actionLabel }))

        expect(useLysStore.getState()).toMatchObject({
          activeView: "settings",
          settingsPane: pane
        })
      }
    )
  })

  describe("model selection", () => {
    /** Two loaded models; the chosen default is the second. */
    const TWO_LOADED: RuntimeArrangement = {
      ...READY_RUNTIME,
      modelInventory: {
        status: "ready",
        models: [
          buildLlmInfo("qwen3-8b", { loaded: true }),
          buildLlmInfo("gemma-3", { loaded: true }),
          buildLlmInfo("llama-4")
        ]
      },
      defaultModel: "gemma-3"
    }

    it("names the weights that answer and sends with them", async () => {
      const { backend, streams } = startChatBackend()
      const { Composer } = await loadFreshComposer(TWO_LOADED)
      const user = userEvent.setup()
      render(
        <Composer messageFieldRef={createRef()} onStartConversation={vi.fn()} />
      )

      expect(screen.getByRole("button", { name: "gemma-3" })).toHaveAttribute(
        "aria-haspopup",
        "menu"
      )
      await user.type(getMessageField(), "Hello{Enter}")
      await waitForRenderedWork()

      expect(listChatBodies(backend)).toEqual([
        expect.objectContaining({ model: "gemma-3" })
      ])
      streams[0]?.close()
    })

    it("switches the answering weights to another loaded model for this session only", async () => {
      startNativeHostFake({})
      const { backend, streams } = startChatBackend()
      const { useLysStore, Composer } = await loadFreshComposer(TWO_LOADED)
      const user = userEvent.setup()
      render(
        <Composer messageFieldRef={createRef()} onStartConversation={vi.fn()} />
      )

      await openMenuWithKeyboard(
        user,
        screen.getByRole("button", { name: "gemma-3" })
      )
      await user.click(screen.getByRole("menuitemradio", { name: /^qwen3-8b/ }))
      await user.type(getMessageField(), "Hello{Enter}")
      await waitForRenderedWork()

      expect(
        screen.getByRole("button", { name: "qwen3-8b" })
      ).toBeInTheDocument()
      expect(useLysStore.getState().settings.runtime.defaultModel).toBe(
        "qwen3-8b"
      )
      expect(listChatBodies(backend)).toEqual([
        expect.objectContaining({ model: "qwen3-8b" })
      ])
      streams[0]?.close()
    })

    it("keeps naming and sending with loaded weights when an unloaded model is chosen", async () => {
      startNativeHostFake({})
      const { backend, streams } = startChatBackend()
      const { Composer } = await loadFreshComposer(TWO_LOADED)
      const user = userEvent.setup()
      render(
        <Composer messageFieldRef={createRef()} onStartConversation={vi.fn()} />
      )

      await openMenuWithKeyboard(
        user,
        screen.getByRole("button", { name: "gemma-3" })
      )
      await user.click(screen.getByRole("menuitemradio", { name: /^llama-4/ }))
      await user.type(getMessageField(), "Hello{Enter}")
      await waitForRenderedWork()

      expect(
        screen.getByRole("button", { name: "qwen3-8b" })
      ).toBeInTheDocument()
      expect(listChatBodies(backend)).toEqual([
        expect.objectContaining({ model: "qwen3-8b" })
      ])
      streams[0]?.close()
    })
  })

  describe("answering agent", () => {
    it("names the field after the agent chosen before the first message and starts the conversation with it", async () => {
      const { backend, streams } = startChatBackend()
      const { Composer } = await loadFreshComposer()
      const user = userEvent.setup()
      render(
        <Composer messageFieldRef={createRef()} onStartConversation={vi.fn()} />
      )

      await openMenuWithKeyboard(
        user,
        screen.getByRole("button", { name: "Caliginia" })
      )
      await user.click(
        screen.getByRole("menuitemradio", { name: /^Lysiptera/ })
      )
      const field = screen.getByRole("textbox", { name: "Message Lysiptera" })
      expect(field).toHaveAttribute("placeholder", "Say something to Lysiptera")
      await user.type(field, "Hello{Enter}")
      await waitForRenderedWork()

      expect(listChatBodies(backend)).toEqual([
        expect.objectContaining({
          conversation: { kind: "new", agentCode: LYSIPTERA_AGENT_CODE }
        })
      ])
      streams[0]?.close()
    })

    it("keeps a conversation whose agent was deleted readable but closed, and asks the parent for a new one", async () => {
      const { backend } = startChatBackend()
      const { useChatViewStore, Composer } = await loadFreshComposer()
      useChatViewStore.setState({
        conversation: createStoredChatViewConversation(
          buildDeletedAgentConversation()
        ),
        inputDraft: "Are you still there?"
      })
      const onStartConversation = vi.fn()
      const user = userEvent.setup()
      render(
        <Composer
          messageFieldRef={createRef()}
          onStartConversation={onStartConversation}
        />
      )

      const field = screen.getByRole("textbox", {
        name: `Message ${DELETED_AGENT_CODE}`
      })
      expect(field).toBeDisabled()
      expect(field).toHaveAttribute(
        "placeholder",
        "This conversation is read-only."
      )
      expect(screen.getByRole("button", { name: "Send" })).toBeDisabled()
      expect(listStatusTexts()).toContain(DELETED_CONVERSATION_AGENT_MESSAGE)

      // The notice sits above the field, so its button precedes the session
      // controls' New conversation.
      const newConversationButtons = screen.getAllByRole("button", {
        name: "New conversation"
      })
      expect(newConversationButtons).toHaveLength(2)
      await user.click(newConversationButtons[0])
      await waitForRenderedWork()

      expect(onStartConversation).toHaveBeenCalledOnce()
      expect(useChatViewStore.getState().conversation?.id).toBe(
        FIXTURE_CONVERSATION_ID
      )
      expect(listRequestsBesideMeasurements(backend)).toEqual([])
    })

    it("lets the unavailable banner stand in for the deleted-agent notice", async () => {
      const { useChatViewStore, Composer } = await loadFreshComposer(
        buildUnreachableRuntime("stopped")
      )
      useChatViewStore.setState({
        conversation: createStoredChatViewConversation(
          buildDeletedAgentConversation()
        )
      })
      render(
        <Composer messageFieldRef={createRef()} onStartConversation={vi.fn()} />
      )

      const statusTexts = listStatusTexts()
      expect(statusTexts).toContainEqual(
        expect.stringContaining("The backend is not running on")
      )
      expect(statusTexts).not.toContain(DELETED_CONVERSATION_AGENT_MESSAGE)
      expect(
        screen.getAllByRole("button", { name: "New conversation" })
      ).toHaveLength(1)
      expect(
        screen.getByRole("textbox", { name: `Message ${DELETED_AGENT_CODE}` })
      ).toHaveAttribute("placeholder", "Waiting on the backend…")
    })
  })

  describe("a tool call that waits for the person", () => {
    it("allows the call on Enter while the draft is empty, instead of sending a message", async () => {
      const host = startNativeHostFake({ read_text_file: () => "Buy milk." })
      const backend = startBackendFake({
        ...MEASURING_BACKEND_ROUTES,
        [READ_APPROVAL_ROUTE]: () => new Response(null, { status: 204 })
      })
      const { Composer } = await loadFreshComposerWithWaitingCall()
      const user = userEvent.setup()
      render(
        <Composer messageFieldRef={createRef()} onStartConversation={vi.fn()} />
      )

      await user.type(getMessageField(), "{Enter}")
      await waitForRenderedWork()

      expect(host.commands).toEqual([])
      expect(listRouteKeysWithoutReplyFollows(backend)).toEqual([
        READ_APPROVAL_ROUTE
      ])
      expect(listRequestsBesideMeasurements(backend)[0]?.body).toEqual({
        status: "allowed"
      })
      expect(
        screen.queryByRole("group", {
          name: "Tool call waiting for your answer"
        })
      ).not.toBeInTheDocument()
    })

    it.each([
      ["Enter", "{Enter}"],
      ["Escape", "{Escape}"]
    ])(
      "rejects the call with the draft as the reason on %s, and clears the draft",
      async (_key, keys) => {
        startNativeHostFake({})
        const backend = startBackendFake({
          ...MEASURING_BACKEND_ROUTES,
          [READ_APPROVAL_ROUTE]: () => new Response(null, { status: 204 })
        })
        const { Composer } = await loadFreshComposerWithWaitingCall()
        const user = userEvent.setup()
        render(
          <Composer
            messageFieldRef={createRef()}
            onStartConversation={vi.fn()}
          />
        )

        await user.type(getMessageField(), `Not that file${keys}`)
        await waitForRenderedWork()

        expect(listRouteKeysWithoutReplyFollows(backend)).toEqual([
          READ_APPROVAL_ROUTE
        ])
        expect(listRequestsBesideMeasurements(backend)[0]?.body).toEqual({
          status: "rejected",
          reason: "declined",
          content: "The person declined this call. They said: Not that file"
        })
        expect(getMessageField()).toHaveValue("")
      }
    )

    it("rejects the call without a reason on Escape while the draft is empty", async () => {
      startNativeHostFake({})
      const backend = startBackendFake({
        ...MEASURING_BACKEND_ROUTES,
        [READ_APPROVAL_ROUTE]: () => new Response(null, { status: 204 })
      })
      const { Composer } = await loadFreshComposerWithWaitingCall()
      const user = userEvent.setup()
      render(
        <Composer messageFieldRef={createRef()} onStartConversation={vi.fn()} />
      )

      await user.type(getMessageField(), "{Escape}")
      await waitForRenderedWork()

      expect(
        listRequestsBesideMeasurements(backend).map((request) => request.body)
      ).toEqual([
        {
          status: "rejected",
          reason: "declined",
          content: "The person declined this call."
        }
      ])
    })

    it("rejects the call with the draft from the card's Reject button, and clears the draft", async () => {
      startNativeHostFake({})
      const backend = startBackendFake({
        ...MEASURING_BACKEND_ROUTES,
        [READ_APPROVAL_ROUTE]: () => new Response(null, { status: 204 })
      })
      const { useChatViewStore, Composer } =
        await loadFreshComposerWithWaitingCall()
      useChatViewStore.setState({ inputDraft: "Use the other folder" })
      const user = userEvent.setup()
      render(
        <Composer messageFieldRef={createRef()} onStartConversation={vi.fn()} />
      )

      await user.click(screen.getByRole("button", { name: "Reject" }))
      await waitForRenderedWork()

      expect(
        listRequestsBesideMeasurements(backend).map((request) => request.body)
      ).toEqual([
        {
          status: "rejected",
          reason: "declined",
          content:
            "The person declined this call. They said: Use the other folder"
        }
      ])
      expect(getMessageField()).toHaveValue("")
    })

    it("adds a line on Shift+Enter and leaves the call waiting", async () => {
      startNativeHostFake({})
      const backend = startBackendFake(MEASURING_BACKEND_ROUTES)
      const { Composer } = await loadFreshComposerWithWaitingCall()
      const user = userEvent.setup()
      render(
        <Composer messageFieldRef={createRef()} onStartConversation={vi.fn()} />
      )

      await user.type(getMessageField(), "Wait{Shift>}{Enter}{/Shift}")
      await waitForRenderedWork()

      expect(getMessageField()).toHaveValue("Wait\n")
      expect(listRequestsBesideMeasurements(backend)).toEqual([])
      expect(
        screen.getByRole("group", { name: "Tool call waiting for your answer" })
      ).toBeInTheDocument()
    })

    it("leaves Escape to the field while only an answer that failed to send is shown", async () => {
      startNativeHostFake({})
      const backend = startBackendFake(MEASURING_BACKEND_ROUTES)
      const { useChatViewStore, Composer } =
        await loadFreshComposerWithWaitingCall()
      const { useToolCallStore } = await import("@/lib/store/tool-calls")
      useToolCallStore.setState({
        heldCalls: [
          {
            target: WAITING_READ.target,
            call: READ_CALL,
            step: "run",
            answer: {
              status: "send-failed",
              toolAnswer: { status: "succeeded", content: "Buy milk." },
              error: "Couldn't send the answer to Lys."
            }
          }
        ]
      })
      useChatViewStore.setState({ inputDraft: "Keep this" })
      const user = userEvent.setup()
      render(
        <Composer messageFieldRef={createRef()} onStartConversation={vi.fn()} />
      )

      await user.type(getMessageField(), "{Escape}")
      await waitForRenderedWork()

      expect(getMessageField()).toHaveValue("Keep this")
      expect(listRequestsBesideMeasurements(backend)).toEqual([])
      expect(
        screen.getByRole("group", { name: "Tool answer not sent" })
      ).toBeInTheDocument()
    })

    // Known defect (#168), the same as for sending: a key pressed while an
    // input method composes text answers the waiting call. Escape, which
    // cancels a composition, rejects the call, and Enter, which confirms one,
    // rejects it with the unfinished draft or allows it.
    it.fails.each(["Escape", "Enter"])(
      "leaves an %s that belongs to text composition to the input method while a call waits",
      async (key) => {
        startNativeHostFake({})
        const backend = startBackendFake({
          ...MEASURING_BACKEND_ROUTES,
          [READ_APPROVAL_ROUTE]: () => new Response(null, { status: 204 })
        })
        const { useChatViewStore, Composer } =
          await loadFreshComposerWithWaitingCall()
        useChatViewStore.setState({ inputDraft: "Konnichi" })
        render(
          <Composer
            messageFieldRef={createRef()}
            onStartConversation={vi.fn()}
          />
        )

        fireEvent.keyDown(getMessageField(), { key, isComposing: true })
        await waitForRenderedWork()

        expect(
          listRequestsBesideMeasurements(backend).map((request) => request.body)
        ).toEqual([])
      }
    )

    it("announces the waiting call under the answering agent's name", async () => {
      const { Composer } = await loadFreshComposerWithWaitingCall()

      render(
        <Composer messageFieldRef={createRef()} onStartConversation={vi.fn()} />
      )

      expect(listStatusTexts()).toContain(
        "Caliginia is waiting for you to allow or reject read_text_file: Read /notes/todo.md. Nothing is changed."
      )
    })
  })

  describe("session controls", () => {
    it("opens past conversations and closes them again, stating which", async () => {
      startBackendFake({
        ...MEASURING_BACKEND_ROUTES,
        [HISTORY_ROUTE]: () =>
          buildJsonResponse(200, buildConversationListPage([]))
      })
      const { useConversationHistoryStore, Composer } =
        await loadFreshComposer()
      const user = userEvent.setup()
      render(
        <Composer messageFieldRef={createRef()} onStartConversation={vi.fn()} />
      )
      const history = screen.getByRole("button", { name: "Past conversations" })

      expect(history).toHaveAttribute("aria-expanded", "false")
      expect(history).toHaveAttribute("aria-haspopup", "dialog")
      expect(history).toHaveAttribute("aria-keyshortcuts", "Meta+K Control+K")

      await user.click(history)
      await waitForRenderedWork()

      expect(history).toHaveAttribute("aria-expanded", "true")
      expect(useConversationHistoryStore.getState().visibility.status).toBe(
        "open"
      )

      await user.click(history)

      expect(history).toHaveAttribute("aria-expanded", "false")
      expect(useConversationHistoryStore.getState().visibility.status).toBe(
        "closed"
      )
    })

    it("starts a new conversation, clearing the shown one and the draft", async () => {
      const { useChatViewStore, Composer } = await loadFreshComposer()
      useChatViewStore.setState({
        conversation: createStoredChatViewConversation(
          buildConversation(FIXTURE_CONVERSATION_ID, "Old", [
            buildUserMessage(2, "Hello")
          ])
        ),
        inputDraft: "Unsent"
      })
      const user = userEvent.setup()
      render(
        <Composer messageFieldRef={createRef()} onStartConversation={vi.fn()} />
      )

      await user.click(screen.getByRole("button", { name: "New conversation" }))

      expect(useChatViewStore.getState().conversation).toBeUndefined()
      expect(getMessageField()).toHaveValue("")
    })

    it("opens Settings", async () => {
      const { useLysStore, Composer } = await loadFreshComposer()
      const user = userEvent.setup()
      render(
        <Composer messageFieldRef={createRef()} onStartConversation={vi.fn()} />
      )

      await user.click(screen.getByRole("button", { name: "Settings" }))

      expect(useLysStore.getState().activeView).toBe("settings")
    })

    it("opens Agents settings from the agent menu", async () => {
      const { useLysStore, Composer } = await loadFreshComposer()
      const user = userEvent.setup()
      render(
        <Composer messageFieldRef={createRef()} onStartConversation={vi.fn()} />
      )

      await openMenuWithKeyboard(
        user,
        screen.getByRole("button", { name: "Caliginia" })
      )
      await user.click(screen.getByRole("menuitem", { name: /Edit agents/ }))

      expect(useLysStore.getState()).toMatchObject({
        activeView: "settings",
        settingsPane: "agents"
      })
    })

    it("opens Model settings to change the context window", async () => {
      const { useLysStore, Composer } = await loadFreshComposer()
      const user = userEvent.setup()
      render(
        <Composer messageFieldRef={createRef()} onStartConversation={vi.fn()} />
      )

      await user.click(screen.getByRole("button", { name: /^Context window/ }))
      await user.click(
        screen.getByRole("button", { name: "Change the window" })
      )

      expect(useLysStore.getState()).toMatchObject({
        activeView: "settings",
        settingsPane: "model"
      })
    })
  })

  describe("context meter", () => {
    it("measures a new conversation with the loaded model and shows the window it is loaded with", async () => {
      const { backend } = startChatBackend()
      const { Composer } = await loadFreshComposer()
      render(
        <Composer messageFieldRef={createRef()} onStartConversation={vi.fn()} />
      )

      await waitForRenderedWork()

      expect(
        backend.requests
          .filter((request) => request.routeKey === CHAT_CONTEXT_ROUTE)
          .map((request) => request.body)
      ).toEqual([
        {
          conversation: { kind: "new", agentCode: CALIGINIA_AGENT_CODE },
          model: "qwen3-8b"
        }
      ])
      expect(
        screen.getByRole("button", { name: "Context window · 2.3k / 8.2k" })
      ).toBeInTheDocument()
    })

    it("refuses to send while the conversation, the draft, and the reply reserve exceed the window", async () => {
      const { backend } = startChatBackend({
        [CHAT_CONTEXT_ROUTE]: () =>
          buildJsonResponse(200, {
            ...FIXTURE_CHAT_CONTEXT_MEASUREMENT,
            historyTokens: 5000,
            historyMessageCount: 4
          })
      })
      const { Composer } = await loadFreshComposer()
      const user = userEvent.setup()
      render(
        <Composer messageFieldRef={createRef()} onStartConversation={vi.fn()} />
      )

      await user.type(getMessageField(), "Summarize this{Enter}")
      await waitForRenderedWork()

      expect(listChatBodies(backend)).toEqual([])
      expect(getMessageField()).toHaveValue("Summarize this")
      expect(screen.getByRole("button", { name: "Send" })).toBeDisabled()
      expect(
        screen.getByRole("button", { name: "Context window · over by ~1.1k" })
      ).toBeInTheDocument()
    })

    it("lets the person send while a newer measurement is pending, whatever the earlier one found", async () => {
      const { route, responses } = createControlledRoute()
      startChatBackend({ [CHAT_CONTEXT_ROUTE]: route })
      const { useChatViewStore, Composer } = await loadFreshComposer()
      const user = userEvent.setup()
      render(
        <Composer messageFieldRef={createRef()} onStartConversation={vi.fn()} />
      )
      await user.type(getMessageField(), "Summarize this")
      await waitForRenderedWork()
      await act(async () => {
        responses[0]?.resolve(
          buildJsonResponse(200, {
            ...FIXTURE_CHAT_CONTEXT_MEASUREMENT,
            historyTokens: 5000,
            historyMessageCount: 4
          })
        )
      })
      await waitForRenderedWork()
      expect(screen.getByRole("button", { name: "Send" })).toBeDisabled()

      act(() => {
        useChatViewStore.getState().selectAgent(LYSIPTERA_AGENT_CODE)
      })
      await waitForRenderedWork()

      expect(responses).toHaveLength(2)
      expect(screen.getByRole("button", { name: "Send" })).toBeEnabled()
    })

    it("lets the person send when the window cannot be measured, and says why", async () => {
      startChatBackend({
        [CHAT_CONTEXT_ROUTE]: () =>
          buildJsonResponse(503, {
            type: "urn:lys:problem:llm:runtime-unavailable",
            title: "LLM runtime unavailable",
            status: 503,
            detail:
              "LM Studio is not reachable. Start LM Studio, then refresh its status in Lys."
          })
      })
      const { Composer } = await loadFreshComposer()
      const user = userEvent.setup()
      render(
        <Composer messageFieldRef={createRef()} onStartConversation={vi.fn()} />
      )

      await user.type(getMessageField(), "Hello")
      await waitForRenderedWork()
      await user.click(
        screen.getByRole("button", { name: "Context window · window unknown" })
      )

      expect(screen.getByRole("button", { name: "Send" })).toBeEnabled()
      expect(
        screen.getByText(
          "LM Studio is not reachable. Start LM Studio, then refresh its status in Lys. Sending still checks that the conversation fits the model."
        )
      ).toBeInTheDocument()
    })
  })

  describe("attachments", () => {
    it("stages chosen files, marks the add action, and removes a file on request", async () => {
      const { Composer } = await loadFreshComposer()
      const user = userEvent.setup()
      const { container } = render(
        <Composer messageFieldRef={createRef()} onStartConversation={vi.fn()} />
      )

      await user.upload(getFileInput(container), [
        new File(["# Notes"], "notes.md"),
        new File(["a,b"], "table.csv")
      ])

      expect(listStagedNames(["notes.md", "table.csv"])).toEqual([
        "notes.md",
        "table.csv"
      ])
      expect(
        screen.getByRole("button", {
          name: "Add to this message; files are attached"
        })
      ).toBeInTheDocument()

      await user.click(
        screen.getByRole("button", { name: "Remove notes.md from context" })
      )

      expect(listStagedNames(["notes.md", "table.csv"])).toEqual(["table.csv"])
    })

    it("stages the same file again and survives a cancelled selection under StrictMode", async () => {
      const { Composer } = await loadFreshComposer()
      const user = userEvent.setup()
      const { container } = render(
        <StrictMode>
          <Composer
            messageFieldRef={createRef()}
            onStartConversation={vi.fn()}
          />
        </StrictMode>
      )
      const notes = new File(["# Notes"], "notes.md")

      await user.upload(getFileInput(container), notes)
      await user.upload(getFileInput(container), notes)
      fireEvent.change(getFileInput(container), { target: { files: [] } })

      expect(listStagedNames(["notes.md"])).toEqual(["notes.md", "notes.md"])
    })

    it("stages dropped files and shows the drop hint only while dragging", async () => {
      const { Composer } = await loadFreshComposer()
      render(
        <Composer messageFieldRef={createRef()} onStartConversation={vi.fn()} />
      )
      const field = getMessageField()

      fireEvent.dragOver(field, { dataTransfer: { files: [] } })
      expect(screen.getByText("release to add to context")).toBeInTheDocument()

      sendFileDrop(field, [new File(["x"], "dropped.txt")])

      expect(screen.queryByText("release to add to context")).toBeNull()
      expect(listStagedNames(["dropped.txt"])).toEqual(["dropped.txt"])
    })

    it("hides the drop hint when the drag leaves the field", async () => {
      const { Composer } = await loadFreshComposer()
      render(
        <Composer messageFieldRef={createRef()} onStartConversation={vi.fn()} />
      )
      const field = getMessageField()
      fireEvent.dragOver(field, { dataTransfer: { files: [] } })

      fireEvent.dragLeave(field, { relatedTarget: document.body })

      expect(screen.queryByText("release to add to context")).toBeNull()
    })

    it("ignores files dropped while generation is unavailable", async () => {
      const { Composer } = await loadFreshComposer(
        buildUnreachableRuntime("stopped")
      )
      render(
        <Composer messageFieldRef={createRef()} onStartConversation={vi.fn()} />
      )
      const field = getMessageField()

      fireEvent.dragOver(field, { dataTransfer: { files: [] } })
      expect(screen.queryByText("release to add to context")).toBeNull()
      sendFileDrop(field, [new File(["x"], "dropped.txt")])

      expect(listStagedNames(["dropped.txt"])).toEqual([])
    })

    it("does not count a staged file against the window, because it is not sent", async () => {
      startChatBackend()
      const { Composer } = await loadFreshComposer()
      const user = userEvent.setup()
      const { container } = render(
        <Composer messageFieldRef={createRef()} onStartConversation={vi.fn()} />
      )
      await user.type(getMessageField(), "Summarize this")

      await user.upload(
        getFileInput(container),
        new File(["x".repeat(130_000)], "export.csv")
      )
      await waitForRenderedWork()

      expect(screen.getByRole("button", { name: "Send" })).toBeEnabled()
      expect(
        screen.getByRole("button", { name: "Context window · 2.3k / 8.2k" })
      ).toBeInTheDocument()
    })

    // Known defect, tracked by #27 and #105: the composer lists a chosen file
    // as attached to the message, but the chat request has no attachment
    // field, so none of the file's content is sent. The expectation holds
    // under either fix: #105 sends the content of every listed file, and
    // #27 lists no file while sending files is unsupported.
    it.fails(
      "sends the content of every file it lists as attached to the message (#27, #105)",
      async () => {
        const { backend, streams } = startChatBackend()
        const { Composer } = await loadFreshComposer()
        const user = userEvent.setup()
        const { container } = render(
          <Composer
            messageFieldRef={createRef()}
            onStartConversation={vi.fn()}
          />
        )
        await user.upload(
          getFileInput(container),
          new File([NOTES_CONTENT], "notes.md")
        )
        const isListedAsAttached = listStagedNames(["notes.md"]).includes(
          "notes.md"
        )

        await user.type(getMessageField(), "Summarize the notes{Enter}")
        await waitForRenderedWork()

        expect(
          listChatBodies(backend).map((body) =>
            isTextInChatBody(body, NOTES_CONTENT)
          ),
          "whether each chat request carries the file listed as attached"
        ).toEqual([isListedAsAttached])
        streams[0]?.close()
      }
    )
  })
})
