import type { ConversationSummary } from "@lys/protocol"
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { useLysStore } from "@/lib/store"
import { useChatViewStore } from "@/lib/store/chat-view"
import { useConversationHistoryStore } from "@/lib/store/conversation-history"
import ChatView from "@/views/ChatView/ChatView"

import {
  buildAssistantMessage,
  buildConversationSummary,
  buildListPage,
  buildStoredConversation,
  buildUserMessage,
  createConversationNotFoundResponse,
  createJsonResponse,
  FIXTURE_IDS
} from "../fixtures/conversations"

/** One request received by the fake backend. */
type BackendRequest = {
  /** HTTP method. */
  readonly method: string
  /** Parsed request URL. */
  readonly url: URL
  /** Serialized request body, when sent. */
  readonly body: string | undefined
}

/**
 * In-memory backend honoring the conversation route contracts over `fetch`.
 *
 * @remarks Lists stored summaries newest first, filters them by a
 * case-insensitive title or preview match, serves stored transcripts, applies
 * renames, and deletes. `failNextList` makes the next list request fail with
 * HTTP 500 to exercise the failure path.
 */
class FakeConversationBackend {
  /** Requests received, in order. */
  readonly requests: BackendRequest[] = []
  /** Whether the next list request fails. */
  failNextList = false
  /** Stored summaries, newest activity first. */
  #summaries: ConversationSummary[]

  /**
   * Creates a backend storing the given summaries.
   *
   * @param summaries - Stored conversations, newest activity first.
   */
  constructor(summaries: readonly ConversationSummary[]) {
    this.#summaries = [...summaries]
  }

  /**
   * Answers one request as the backend would.
   *
   * @param input - Requested URL.
   * @param init - Request method and body.
   * @returns The contract response for the request.
   */
  async respond(
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    const request: BackendRequest = {
      method: init?.method ?? "GET",
      url: new URL(String(input)),
      body: typeof init?.body === "string" ? init.body : undefined
    }
    this.requests.push(request)
    const conversationId = request.url.pathname.split("/")[4]
    if (conversationId === undefined) return this.#list(request.url)
    if (request.method === "GET") return this.#get(conversationId)
    if (request.method === "PATCH") return this.#rename(conversationId, request)

    return this.#delete(conversationId)
  }

  /**
   * Lists summaries matching the request's query.
   *
   * @param url - List URL carrying the optional query.
   * @returns The single page of matches.
   */
  #list(url: URL): Response {
    if (this.failNextList) {
      this.failNextList = false
      return createJsonResponse({ message: "boom" }, 500)
    }
    const query = url.searchParams.get("query")?.toLowerCase() ?? ""
    const matches = this.#summaries.filter((summary) =>
      `${summary.title} ${summary.preview?.content}`
        .toLowerCase()
        .includes(query)
    )

    return createJsonResponse(
      buildListPage({
        conversations: matches,
        storedCount: this.#summaries.length,
        matchCount: matches.length,
        nextCursor: null
      }),
      200
    )
  }

  /**
   * Serves one stored transcript.
   *
   * @param conversationId - Requested conversation.
   * @returns The stored conversation or the not-found problem.
   */
  #get(conversationId: string): Response {
    const summary = this.#summaries.find(
      (stored) => stored.id === conversationId
    )
    if (summary === undefined) return createConversationNotFoundResponse()

    return createJsonResponse(
      buildStoredConversation(conversationId, [
        buildUserMessage(FIXTURE_IDS.userMessage, "Sketch the pipeline"),
        buildAssistantMessage({
          id: FIXTURE_IDS.assistantMessage,
          content: "Three moving parts.",
          status: "completed",
          finishReason: "stop"
        })
      ]),
      200
    )
  }

  /**
   * Applies one rename.
   *
   * @param conversationId - Renamed conversation.
   * @param request - Request carrying the JSON title body.
   * @returns The updated metadata or the not-found problem.
   */
  #rename(conversationId: string, request: BackendRequest): Response {
    const index = this.#summaries.findIndex(
      (stored) => stored.id === conversationId
    )
    if (index === -1) return createConversationNotFoundResponse()
    const { title } = JSON.parse(request.body ?? "{}") as { title: string }
    this.#summaries[index] = { ...this.#summaries[index], title }

    return createJsonResponse(
      {
        id: conversationId,
        title,
        systemPrompt: "You are Lys.",
        createdAt: this.#summaries[index].createdAt,
        updatedAt: this.#summaries[index].updatedAt
      },
      200
    )
  }

  /**
   * Deletes one conversation.
   *
   * @param conversationId - Deleted conversation.
   * @returns A bodyless 204.
   */
  #delete(conversationId: string): Response {
    this.#summaries = this.#summaries.filter(
      (stored) => stored.id !== conversationId
    )
    return new Response(null, { status: 204 })
  }
}

/** Epoch milliseconds the store samples as the opening time. */
const NOW_MS = Date.parse("2026-09-11T12:00:00.000Z")

/** Two stored conversations updated today. */
const STORED_SUMMARIES: readonly ConversationSummary[] = [
  buildConversationSummary({
    id: FIXTURE_IDS.firstConversation,
    title: "Streaming pipeline",
    updatedAt: "2026-09-11T11:49:00.000Z",
    preview: { role: "user", content: "Sketch the Pipeline for a local model." }
  }),
  buildConversationSummary({
    id: FIXTURE_IDS.secondConversation,
    title: "What are you?",
    updatedAt: "2026-09-11T09:36:00.000Z",
    preview: { role: "assistant", content: "A voice running on your model." }
  })
]

let backend: FakeConversationBackend

/**
 * Renders the chat view and returns a user-event session.
 *
 * @returns The session driving the rendered view.
 */
function renderChatView() {
  const user = userEvent.setup()
  render(<ChatView atBottom onScrollPositionChange={() => undefined} />)
  return user
}

/**
 * Opens history with the keyboard shortcut and waits for its rows.
 *
 * @param user - Session driving the rendered view.
 * @returns The history dialog.
 */
async function openHistory(user: ReturnType<typeof userEvent.setup>) {
  await user.keyboard("{Meta>}k{/Meta}")
  const dialog = await screen.findByRole("dialog", {
    name: "Past conversations"
  })
  await within(dialog).findByRole("button", { name: /^Streaming pipeline/ })
  return dialog
}

beforeEach(() => {
  vi.stubEnv("TZ", "UTC")
  vi.spyOn(Date, "now").mockReturnValue(NOW_MS)
  backend = new FakeConversationBackend(STORED_SUMMARIES)
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      backend.respond(input, init)
    )
  )
  useLysStore.setState({
    backendServerInfo: { status: "running" },
    modelRuntime: { status: "loaded", modelKey: "fixture/model" }
  })
})

afterEach(() => {
  useConversationHistoryStore.getState().closeConversationHistory()
  useChatViewStore.getState().resetConversation()
  useConversationHistoryStore.setState(
    useConversationHistoryStore.getInitialState(),
    true
  )
  useChatViewStore.setState(useChatViewStore.getInitialState(), true)
  useLysStore.setState(useLysStore.getInitialState(), true)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe("conversation history in the chat view", () => {
  it("opens from the shortcut with focus in search and conversations grouped by day", async () => {
    const user = renderChatView()

    const dialog = await openHistory(user)

    expect(
      within(dialog).getByRole("searchbox", {
        name: "recall past conversations"
      })
    ).toHaveFocus()
    expect(within(dialog).getByRole("group", { name: "Today" })).toBeVisible()
    expect(within(dialog).getByText("2 kept")).toBeVisible()
    expect(
      within(dialog).getByRole("button", { name: /^What are you\?.*09:36$/ })
    ).toBeVisible()
    expect(
      screen.getByRole("button", { name: "Past conversations" })
    ).toHaveAttribute("aria-expanded", "true")
  })

  it("searches by substring, counts matches, and highlights the match", async () => {
    const user = renderChatView()
    const dialog = await openHistory(user)

    await user.type(within(dialog).getByRole("searchbox"), "pipe")

    await within(dialog).findByText("1 of 2")
    expect(backend.requests.at(-1)?.url.searchParams.get("query")).toBe("pipe")
    expect(
      within(dialog).queryByRole("button", { name: /^What are you/ })
    ).toBeNull()
    expect(dialog.querySelector("mark")).toHaveTextContent("Pipe")
  })

  it("clears the search on the first Escape and closes on the second, returning focus", async () => {
    const user = renderChatView()
    const historyButton = screen.getByRole("button", {
      name: "Past conversations"
    })
    await user.click(historyButton)
    const dialog = await screen.findByRole("dialog", {
      name: "Past conversations"
    })
    const searchbox = within(dialog).getByRole("searchbox")
    await user.type(searchbox, "x")

    await user.keyboard("{Escape}")
    expect(searchbox).toHaveValue("")
    expect(dialog).toBeInTheDocument()

    await user.keyboard("{Escape}")
    await waitFor(() => expect(dialog).not.toBeInTheDocument())
    expect(historyButton).toHaveFocus()
    expect(historyButton).toHaveAttribute("aria-expanded", "false")
  })

  it("moves between rows with the arrows and continues the chosen conversation", async () => {
    const user = renderChatView()
    const dialog = await openHistory(user)
    const firstRow = within(dialog).getByRole("button", {
      name: /^Streaming pipeline/
    })
    const secondRow = within(dialog).getByRole("button", {
      name: /^What are you/
    })

    await user.keyboard("{ArrowDown}")
    expect(firstRow).toHaveFocus()
    await user.keyboard("{ArrowDown}")
    expect(secondRow).toHaveFocus()
    await user.keyboard("{ArrowUp}{ArrowUp}")
    expect(within(dialog).getByRole("searchbox")).toHaveFocus()

    await user.keyboard("{ArrowDown}{Enter}")

    await waitFor(() => expect(dialog).not.toBeInTheDocument())
    expect(screen.getByRole("textbox", { name: "Message Lys" })).toHaveFocus()
    expect(await screen.findByText("Three moving parts.")).toBeVisible()
    expect(useChatViewStore.getState().conversation?.id).toBe(
      FIXTURE_IDS.firstConversation
    )
  })

  it("renames in place with F2 and Enter, keeping focus on the row", async () => {
    const user = renderChatView()
    const dialog = await openHistory(user)
    await user.keyboard("{ArrowDown}{F2}")
    const titleField = within(dialog).getByRole("textbox", {
      name: "rename conversation"
    })
    expect(titleField).toHaveFocus()
    expect(titleField).toHaveValue("Streaming pipeline")

    await user.clear(titleField)
    await user.type(titleField, "  Renamed  {Enter}")

    const renamedRow = await within(dialog).findByRole("button", {
      name: /^Renamed/
    })
    expect(renamedRow).toHaveFocus()
    const rename = backend.requests.find(
      (request) => request.method === "PATCH"
    )
    expect(rename?.body).toBe(JSON.stringify({ title: "Renamed" }))
  })

  it("cancels a rename with Escape without sending it or closing history", async () => {
    const user = renderChatView()
    const dialog = await openHistory(user)
    await user.keyboard("{ArrowDown}{F2}")

    await user.type(
      within(dialog).getByRole("textbox", { name: "rename conversation" }),
      " draft{Escape}"
    )

    expect(dialog).toBeInTheDocument()
    expect(
      within(dialog).getByRole("button", { name: /^Streaming pipeline/ })
    ).toHaveFocus()
    expect(backend.requests.some((request) => request.method === "PATCH")).toBe(
      false
    )
  })

  it("keeps a rename open when focus leaves without a destination", async () => {
    const user = renderChatView()
    const dialog = await openHistory(user)
    await user.keyboard("{ArrowDown}{F2}")
    const titleField = within(dialog).getByRole("textbox", {
      name: "rename conversation"
    })
    await user.type(titleField, " draft")

    fireEvent.blur(titleField, { relatedTarget: null })

    expect(titleField).toBeInTheDocument()
    expect(titleField).toHaveValue("Streaming pipeline draft")
    expect(backend.requests.some((request) => request.method === "PATCH")).toBe(
      false
    )
  })

  it("deletes after confirmation and moves focus to the next conversation", async () => {
    const user = renderChatView()
    const dialog = await openHistory(user)

    await user.click(
      within(dialog).getByRole("button", { name: "Delete Streaming pipeline" })
    )
    const confirmation = within(dialog).getByRole("group", {
      name: "Delete Streaming pipeline for good?"
    })
    expect(
      within(confirmation).getByRole("button", { name: "Keep" })
    ).toHaveFocus()
    await user.click(
      within(confirmation).getByRole("button", { name: "Delete" })
    )

    await waitFor(() =>
      expect(
        within(dialog).queryByRole("button", { name: /^Streaming pipeline/ })
      ).toBeNull()
    )
    expect(
      within(dialog).getByRole("button", { name: /^What are you/ })
    ).toHaveFocus()
    expect(within(dialog).getByText("1 kept")).toBeVisible()
    expect(
      backend.requests.find((request) => request.method === "DELETE")?.url
        .pathname
    ).toBe(`/api/v1/conversations/${FIXTURE_IDS.firstConversation}`)
  })

  it("closes when a pointer presses outside the panel", async () => {
    const user = renderChatView()
    const dialog = await openHistory(user)

    await user.pointer({
      keys: "[MouseLeft]",
      target: screen.getByRole("region", { name: "Conversation" })
    })

    await waitFor(() => expect(dialog).not.toBeInTheDocument())
  })

  it("shows a failed read with a retry that reads again", async () => {
    backend.failNextList = true
    const user = renderChatView()
    await user.keyboard("{Meta>}k{/Meta}")
    const dialog = await screen.findByRole("dialog", {
      name: "Past conversations"
    })

    await user.click(
      await within(dialog).findByRole("button", { name: "Try again" })
    )

    expect(
      await within(dialog).findByRole("button", { name: /^Streaming pipeline/ })
    ).toBeVisible()
  })

  it("starts a new conversation from the footer and focuses the message field", async () => {
    const user = renderChatView()
    await openHistory(user)
    await user.keyboard("{ArrowDown}{Enter}")
    await screen.findByText("Three moving parts.")
    const dialog = await openHistory(user)

    await user.click(
      within(dialog).getByRole("button", { name: "Start a new one" })
    )

    await waitFor(() => expect(dialog).not.toBeInTheDocument())
    expect(useChatViewStore.getState().conversation).toBeUndefined()
    expect(screen.getByRole("textbox", { name: "Message Lys" })).toHaveFocus()
  })

  it("closes when Tab moves focus past the panel", async () => {
    const user = renderChatView()
    const dialog = await openHistory(user)
    within(dialog).getByRole("button", { name: "Start a new one" }).focus()

    await user.tab()

    await waitFor(() => expect(dialog).not.toBeInTheDocument())
    expect(document.activeElement).not.toBe(document.body)
  })

  it("closes the conversation in the chat view when it is deleted", async () => {
    const user = renderChatView()
    await openHistory(user)
    await user.keyboard("{ArrowDown}{Enter}")
    await screen.findByText("Three moving parts.")
    const dialog = await openHistory(user)
    expect(
      within(dialog).getByRole("button", { name: /^Streaming pipeline\s*open/ })
    ).toHaveAttribute("aria-current", "true")

    await user.click(
      within(dialog).getByRole("button", { name: "Delete Streaming pipeline" })
    )
    await user.click(within(dialog).getByRole("button", { name: "Delete" }))

    await waitFor(() =>
      expect(useChatViewStore.getState().conversation).toBeUndefined()
    )
    expect(screen.queryByText("Three moving parts.")).toBeNull()
  })
})
