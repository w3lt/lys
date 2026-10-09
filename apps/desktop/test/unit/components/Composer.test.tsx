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
import { describe, expect, it, vi } from "vitest"
import { createStoredChatViewConversation } from "@/lib/store/chat-view/conversation-transitions"
import {
  buildJsonResponse,
  startBackendEventStream,
  startBackendFake,
  type BackendEventStream,
  type BackendRoutes
} from "../support/backendFake"
import {
  buildConversation,
  buildConversationListPage,
  buildConversationMetadata,
  buildStreamingAssistantMessage,
  buildUserMessage,
  FIXTURE_CONVERSATION_ID
} from "../support/conversationFixtures"
import { buildLlmInfo } from "../support/modelFixtures"
import { startNativeHostFake } from "../support/nativeHostFake"
import {
  arrangeRuntime,
  READY_RUNTIME,
  type RuntimeArrangement
} from "../support/runtimeFixtures"
import {
  createControlledPromise,
  waitForMicrotasks
} from "../support/settlement"

/** Route key of the chat request. */
const CHAT_ROUTE = "POST /api/v1/chat"

/** Route key of the history list read. */
const HISTORY_ROUTE = "GET /api/v1/conversations"

/** Reply the first turn streams. */
const REPLY = buildStreamingAssistantMessage(3, "")

/** Route key of the stop request for {@link REPLY}. */
const STOP_REPLY_ROUTE = `POST /api/v1/chat/${FIXTURE_CONVERSATION_ID}/replies/${REPLY.id}/stop`

/** Start event of a turn that creates the fixture conversation. */
const NEW_TURN_EVENT = Object.freeze({
  type: "start-new-conversation-turn",
  conversation: buildConversationMetadata(FIXTURE_CONVERSATION_ID, null),
  userMessage: buildUserMessage(2, "Hello"),
  assistantMessage: REPLY
})

/**
 * Loads fresh application, chat-view, and history stores with the composer
 * that reads them, and arranges the runtime the case needs.
 *
 * @param runtime - Backend, LM Studio, and model facts; the residency is
 * derived from them as the application store derives it.
 * @returns The stores and the composer component.
 */
async function loadFreshComposer(runtime: RuntimeArrangement = READY_RUNTIME) {
  vi.resetModules()
  const { useLysStore } = await import("@/lib/store")
  const { useChatViewStore } = await import("@/lib/store/chat-view")
  const { useConversationHistoryStore } =
    await import("@/lib/store/conversation-history")
  const { Composer } = await import("@/components/Composer")
  arrangeRuntime(useLysStore, runtime)
  return {
    useLysStore,
    useChatViewStore,
    useConversationHistoryStore,
    Composer
  }
}

/**
 * Starts a backend whose chat route opens a new event stream per request.
 *
 * @param routes - Other routes the case needs.
 * @returns The backend observation handle and the opened streams in order.
 */
function startChatBackend(routes: BackendRoutes = {}) {
  const streams: BackendEventStream[] = []
  const backend = startBackendFake({
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
 * Lists the route keys of the requests a backend received, in order.
 *
 * @param backend - Backend observation handle.
 * @returns `<METHOD> <path>` of each request.
 */
function listRouteKeys(backend: ReturnType<typeof startBackendFake>) {
  return backend.requests.map(
    (request) => `${request.method} ${new URL(request.url).pathname}`
  )
}

/**
 * Lets pending requests and store updates settle inside a React update scope.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await waitForMicrotasks()
  })
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
 * Gets the message field.
 *
 * @returns The composer's textarea.
 */
function getMessageField(): HTMLElement {
  return screen.getByRole("textbox", { name: "Message Lys" })
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
 * Lists the names staged in the attachment tray.
 *
 * @returns The chip names in order, or none when no tray is shown.
 */
function listStagedNames(): string[] {
  const tray = screen.queryByRole("list", { name: "Attached to this message" })
  if (tray === null) return []
  return within(tray)
    .getAllByRole("listitem")
    .map(
      (item) => item.querySelector("button")?.getAttribute("aria-label") ?? ""
    )
    .map((label) => label.replace(/^Remove (.+?) from context.*$/, "$1"))
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
function dropFiles(target: Element, files: readonly File[]): void {
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

/**
 * Opens a menu from its focused trigger with the keyboard.
 *
 * @param user - User-event session of the case.
 * @param trigger - Menu trigger.
 * @remarks Base UI opens menus on a pointer press that jsdom does not
 * reproduce; Enter is the supported keyboard path to the same open state.
 */
async function openMenuWithKeyboard(
  user: ReturnType<typeof userEvent.setup>,
  trigger: HTMLElement
): Promise<void> {
  trigger.focus()
  await user.keyboard("{Enter}")
}

describe("Composer", () => {
  describe("drafting and sending", () => {
    it("keeps Send disabled until the draft has text, which the chat store owns", async () => {
      const { useChatViewStore, Composer } = await loadFreshComposer()
      const user = userEvent.setup()
      render(<Composer messageFieldRef={createRef()} />)

      const field = getMessageField()
      expect(field).toHaveAttribute("placeholder", "Say something to Lys")
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

      render(<Composer messageFieldRef={messageFieldRef} />)

      expect(messageFieldRef.current).toBe(getMessageField())
    })

    it("sends the draft once on Enter with the loaded model and saved generation settings", async () => {
      const { backend, streams } = startChatBackend()
      const { useLysStore, Composer } = await loadFreshComposer()
      const { generation } = useLysStore.getState().settings
      const user = userEvent.setup()
      render(<Composer messageFieldRef={createRef()} />)

      await user.type(getMessageField(), "Hello{Enter}")
      await settle()

      expect(listChatBodies(backend)).toEqual([
        {
          conversation: { kind: "new", agentCode: "lys" },
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
      render(<Composer messageFieldRef={createRef()} />)

      await user.type(getMessageField(), "Hello{Shift>}{Enter}{/Shift}there")
      await settle()

      expect(getMessageField()).toHaveValue("Hello\nthere")
      expect(backend.requests).toEqual([])
    })

    it("neither sends nor adds a line on Enter with a blank draft", async () => {
      const { backend } = startChatBackend()
      const { Composer } = await loadFreshComposer()
      const user = userEvent.setup()
      render(<Composer messageFieldRef={createRef()} />)

      await user.type(getMessageField(), "  {Enter}")
      await settle()

      expect(getMessageField()).toHaveValue("  ")
      expect(backend.requests).toEqual([])
    })

    it("sends the draft when Send is pressed", async () => {
      const { backend, streams } = startChatBackend()
      const { Composer } = await loadFreshComposer()
      const user = userEvent.setup()
      render(<Composer messageFieldRef={createRef()} />)
      await user.type(getMessageField(), "Hello")

      await user.click(screen.getByRole("button", { name: "Send" }))
      await settle()

      expect(listChatBodies(backend)).toHaveLength(1)
      streams[0]?.close()
    })

    it("keeps a short paste in the draft", async () => {
      const { Composer } = await loadFreshComposer()
      const user = userEvent.setup()
      render(<Composer messageFieldRef={createRef()} />)
      await user.click(getMessageField())

      await user.paste("short pasted text")

      expect(getMessageField()).toHaveValue("short pasted text")
      expect(listStagedNames()).toEqual([])
    })

    // Known defect, tracked by #27: a paste of 1,200 characters or more is
    // moved out of the draft into a tray entry whose text is never sent.
    it.fails("keeps a long paste in the draft and sends it (#27)", async () => {
      const { backend, streams } = startChatBackend()
      const { Composer } = await loadFreshComposer()
      const longText = "a long pasted passage ".repeat(60)
      const user = userEvent.setup()
      render(<Composer messageFieldRef={createRef()} />)
      await user.click(getMessageField())

      await user.paste(longText)
      await user.keyboard("{Enter}")
      await settle()

      expect(listChatBodies(backend)).toEqual([
        expect.objectContaining({ message: longText.trim() })
      ])
      streams[0]?.close()
    })
  })

  describe("request phases", () => {
    it("offers Stop while the turn is awaited, and stops the reply once it is known", async () => {
      const { backend, streams } = startChatBackend({
        [STOP_REPLY_ROUTE]: () => new Response(null, { status: 204 })
      })
      const { Composer } = await loadFreshComposer()
      const user = userEvent.setup()
      render(<Composer messageFieldRef={createRef()} />)
      await user.type(getMessageField(), "Hello{Enter}")
      await settle()

      expect(screen.queryByRole("button", { name: "Send" })).toBeNull()
      expect(screen.getByText("Generating…")).toBeInTheDocument()
      await user.click(screen.getByRole("button", { name: "Stop reply" }))
      await settle()
      expect(listRouteKeys(backend)).toEqual([CHAT_ROUTE])

      await sendStreamEvents(streams[0], NEW_TURN_EVENT)

      expect(listRouteKeys(backend)).toEqual([CHAT_ROUTE, STOP_REPLY_ROUTE])
      streams[0]?.close()
    })

    it("asks the backend to stop a streaming reply and keeps the draft typed meanwhile", async () => {
      const { backend, streams } = startChatBackend({
        [STOP_REPLY_ROUTE]: () => new Response(null, { status: 204 })
      })
      const { Composer } = await loadFreshComposer()
      const user = userEvent.setup()
      render(<Composer messageFieldRef={createRef()} />)
      await user.type(getMessageField(), "Hello{Enter}")
      await settle()
      await sendStreamEvents(streams[0], NEW_TURN_EVENT, {
        type: "delta",
        content: "Hi"
      })
      expect(getMessageField()).toHaveValue("")

      await user.type(getMessageField(), "Next question")
      await user.click(screen.getByRole("button", { name: "Stop reply" }))
      await settle()
      await sendStreamEvents(streams[0], { type: "interrupted" })

      expect(listRouteKeys(backend)).toEqual([CHAT_ROUTE, STOP_REPLY_ROUTE])
      expect(getMessageField()).toHaveValue("Next question")
      expect(screen.getByRole("button", { name: "Send" })).toBeEnabled()
      streams[0]?.close()
    })

    it("offers Send once the reply is final, while its stream may still carry a title", async () => {
      const { streams } = startChatBackend()
      const { Composer } = await loadFreshComposer()
      const user = userEvent.setup()
      render(<Composer messageFieldRef={createRef()} />)
      await user.type(getMessageField(), "Hello{Enter}")
      await settle()

      await sendStreamEvents(
        streams[0],
        NEW_TURN_EVENT,
        { type: "delta", content: "Hi" },
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
      render(<Composer messageFieldRef={createRef()} />)

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
      const { useLysStore, Composer } = await loadFreshComposer({
        ...READY_RUNTIME,
        backendStatus: "stopped"
      })
      const { backendAddress } = useLysStore.getState().settings.runtime
      const user = userEvent.setup()
      render(<Composer messageFieldRef={createRef()} />)

      expect(screen.getByRole("status")).toHaveTextContent(
        `The backend is not running on ${backendAddress}.`
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
      await settle()

      expect(host.commands.map((invoked) => invoked.command)).toEqual([
        "get_backend_status",
        "start_backend"
      ])
      expect(screen.getByRole("status")).toHaveTextContent(
        `Starting the backend on ${backendAddress}…`
      )
      expect(screen.getByRole("button", { name: "Working" })).toBeDisabled()

      start.resolve({ running: false })
      await settle()
    })

    it.each([
      [
        "LM Studio is not reachable",
        { ...READY_RUNTIME, lmStudioStatus: "unreachable" },
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
        render(<Composer messageFieldRef={createRef()} />)

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
      render(<Composer messageFieldRef={createRef()} />)

      expect(screen.getByRole("button", { name: "gemma-3" })).toHaveAttribute(
        "aria-haspopup",
        "menu"
      )
      await user.type(getMessageField(), "Hello{Enter}")
      await settle()

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
      render(<Composer messageFieldRef={createRef()} />)

      await openMenuWithKeyboard(
        user,
        screen.getByRole("button", { name: "gemma-3" })
      )
      await user.click(screen.getByRole("menuitemradio", { name: /^qwen3-8b/ }))
      await user.type(getMessageField(), "Hello{Enter}")
      await settle()

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
      render(<Composer messageFieldRef={createRef()} />)

      await openMenuWithKeyboard(
        user,
        screen.getByRole("button", { name: "gemma-3" })
      )
      await user.click(screen.getByRole("menuitemradio", { name: /^llama-4/ }))
      await user.type(getMessageField(), "Hello{Enter}")
      await settle()

      expect(
        screen.getByRole("button", { name: "qwen3-8b" })
      ).toBeInTheDocument()
      expect(listChatBodies(backend)).toEqual([
        expect.objectContaining({ model: "qwen3-8b" })
      ])
      streams[0]?.close()
    })
  })

  describe("session controls", () => {
    it("opens past conversations and closes them again, stating which", async () => {
      startBackendFake({
        [HISTORY_ROUTE]: () =>
          buildJsonResponse(200, buildConversationListPage([]))
      })
      const { useConversationHistoryStore, Composer } =
        await loadFreshComposer()
      const user = userEvent.setup()
      render(<Composer messageFieldRef={createRef()} />)
      const history = screen.getByRole("button", { name: "Past conversations" })

      expect(history).toHaveAttribute("aria-expanded", "false")
      expect(history).toHaveAttribute("aria-haspopup", "dialog")
      expect(history).toHaveAttribute("aria-keyshortcuts", "Meta+K Control+K")

      await user.click(history)
      await settle()

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
      render(<Composer messageFieldRef={createRef()} />)

      await user.click(screen.getByRole("button", { name: "New conversation" }))

      expect(useChatViewStore.getState().conversation).toBeUndefined()
      expect(getMessageField()).toHaveValue("")
    })

    it("opens Settings", async () => {
      const { useLysStore, Composer } = await loadFreshComposer()
      const user = userEvent.setup()
      render(<Composer messageFieldRef={createRef()} />)

      await user.click(screen.getByRole("button", { name: "Settings" }))

      expect(useLysStore.getState().activeView).toBe("settings")
    })

    it("opens Model settings to change the context window", async () => {
      const { useLysStore, Composer } = await loadFreshComposer()
      const user = userEvent.setup()
      render(<Composer messageFieldRef={createRef()} />)

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

  describe("attachments", () => {
    it("stages chosen files, marks the add action, and removes a file on request", async () => {
      const { Composer } = await loadFreshComposer()
      const user = userEvent.setup()
      const { container } = render(<Composer messageFieldRef={createRef()} />)

      await user.upload(getFileInput(container), [
        new File(["# Notes"], "notes.md"),
        new File(["a,b"], "table.csv")
      ])

      expect(listStagedNames()).toEqual(["notes.md", "table.csv"])
      expect(
        screen.getByRole("button", {
          name: "Add to this message; files are attached"
        })
      ).toBeInTheDocument()

      await user.click(
        screen.getByRole("button", { name: "Remove notes.md from context" })
      )

      expect(listStagedNames()).toEqual(["table.csv"])
    })

    it("stages the same file again and survives a cancelled selection under StrictMode", async () => {
      const { Composer } = await loadFreshComposer()
      const user = userEvent.setup()
      const { container } = render(
        <StrictMode>
          <Composer messageFieldRef={createRef()} />
        </StrictMode>
      )
      const notes = new File(["# Notes"], "notes.md")

      await user.upload(getFileInput(container), notes)
      await user.upload(getFileInput(container), notes)
      fireEvent.change(getFileInput(container), { target: { files: [] } })

      expect(listStagedNames()).toEqual(["notes.md", "notes.md"])
    })

    it("stages dropped files and shows the drop hint only while dragging", async () => {
      const { Composer } = await loadFreshComposer()
      render(<Composer messageFieldRef={createRef()} />)
      const field = getMessageField()

      fireEvent.dragOver(field, { dataTransfer: { files: [] } })
      expect(screen.getByText("release to add to context")).toBeInTheDocument()

      dropFiles(field, [new File(["x"], "dropped.txt")])

      expect(screen.queryByText("release to add to context")).toBeNull()
      expect(listStagedNames()).toEqual(["dropped.txt"])
    })

    it("hides the drop hint when the drag leaves the field", async () => {
      const { Composer } = await loadFreshComposer()
      render(<Composer messageFieldRef={createRef()} />)
      const field = getMessageField()
      fireEvent.dragOver(field, { dataTransfer: { files: [] } })

      fireEvent.dragLeave(field, { relatedTarget: document.body })

      expect(screen.queryByText("release to add to context")).toBeNull()
    })

    it("ignores files dropped while generation is unavailable", async () => {
      const { Composer } = await loadFreshComposer({
        ...READY_RUNTIME,
        backendStatus: "stopped"
      })
      render(<Composer messageFieldRef={createRef()} />)
      const field = getMessageField()

      fireEvent.dragOver(field, { dataTransfer: { files: [] } })
      expect(screen.queryByText("release to add to context")).toBeNull()
      dropFiles(field, [new File(["x"], "dropped.txt")])

      expect(listStagedNames()).toEqual([])
    })

    it("refuses to send while a staged file overflows the window, until it is removed", async () => {
      const { backend } = startChatBackend()
      const { Composer } = await loadFreshComposer()
      const user = userEvent.setup()
      const { container } = render(<Composer messageFieldRef={createRef()} />)
      await user.type(getMessageField(), "Summarize this")

      await user.upload(
        getFileInput(container),
        new File(["x".repeat(130_000)], "export.csv")
      )
      await user.type(getMessageField(), "{Enter}")
      await settle()

      expect(backend.requests).toEqual([])
      expect(getMessageField()).toHaveValue("Summarize this")
      expect(screen.getByRole("button", { name: "Send" })).toBeDisabled()
      expect(
        screen.getByRole("button", { name: /^Context window · over by ~/ })
      ).toBeInTheDocument()

      await user.click(
        screen.getByRole("button", {
          name: "Remove export.csv from context; it does not fit the window"
        })
      )

      expect(screen.getByRole("button", { name: "Send" })).toBeEnabled()
    })

    // Known defect, tracked by #27: the composer offers to attach files and
    // lists them as attached to the message, but the chat request carries no
    // attachment, so nothing of the file is sent.
    it.fails(
      "offers no file attachment the chat request cannot carry (#27)",
      async () => {
        const { Composer } = await loadFreshComposer()
        const user = userEvent.setup()
        render(<Composer messageFieldRef={createRef()} />)

        await openMenuWithKeyboard(
          user,
          screen.getByRole("button", { name: "Add to this message" })
        )

        const enabledActions = screen
          .getAllByRole("menuitem")
          .filter((item) => item.getAttribute("aria-disabled") !== "true")
          .map((item) => item.textContent)
        expect(enabledActions).not.toContain("Attach a file")
      }
    )
  })
})
