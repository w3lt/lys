import type { ConversationSummary } from "@lys/protocol"
import { StrictMode } from "react"
import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createStoredChatViewConversation } from "@/lib/store/chat-view/conversation-transitions"
import {
  buildJsonResponse,
  startBackendFake,
  type BackendRoute,
  type BackendRoutes
} from "../../support/backendFake"
import {
  buildConversation,
  buildConversationListPage,
  buildConversationMetadata,
  buildConversationSummary,
  buildUserMessage,
  createFixtureUuidV7
} from "../../support/conversationFixtures"
import { waitForMicrotasks } from "../../support/settlement"

/** Route key of the conversation list. */
const LIST_ROUTE = "GET /api/v1/conversations"

/** Newest listed conversation. */
const TRIP = buildConversationSummary(createFixtureUuidV7(3), "Trip", {
  role: "user",
  content: "Plan a trip"
})

/** Older listed conversation. */
const RECIPE = buildConversationSummary(createFixtureUuidV7(2), "Recipe", null)

/** Route key of renaming {@link TRIP}. */
const RENAME_TRIP_ROUTE = `PATCH /api/v1/conversations/${TRIP.id}`

/** Route key of deleting {@link TRIP}. */
const DELETE_TRIP_ROUTE = `DELETE /api/v1/conversations/${TRIP.id}`

/**
 * Builds a list route that answers each search with the listed
 * conversations whose title contains it, case-insensitively.
 *
 * @param conversations - Stored conversations, newest first.
 * @returns The route.
 */
function buildSearchingListRoute(
  conversations: readonly ConversationSummary[]
): BackendRoute {
  return (request) => {
    const query = new URL(request.url).searchParams.get("query") ?? ""
    const matches = conversations.filter((conversation) =>
      (conversation.title ?? "").toLowerCase().includes(query.toLowerCase())
    )
    return buildJsonResponse(
      200,
      buildConversationListPage(matches, { storedCount: conversations.length })
    )
  }
}

/**
 * Loads fresh application, chat-view, and history stores with the panel,
 * with a running backend.
 *
 * @returns The stores and the panel component.
 */
async function loadFreshHistoryPanel() {
  vi.resetModules()
  const { useLysStore } = await import("@/lib/store")
  const { useChatViewStore } = await import("@/lib/store/chat-view")
  const { useConversationHistoryStore } =
    await import("@/lib/store/conversation-history")
  const { default: ConversationHistoryPanel } =
    await import("@/components/ConversationHistoryComponents/ConversationHistoryPanel")
  useLysStore.setState({ backendServerInfo: { status: "running" } })
  return {
    useChatViewStore,
    useConversationHistoryStore,
    ConversationHistoryPanel
  }
}

/** Fresh stores and panel of one case. */
type HistoryPanelModules = Awaited<ReturnType<typeof loadFreshHistoryPanel>>

/**
 * Renders the panel under a parent that shows it while history is open, as
 * the chat view does, next to an opener button and an unrelated paragraph.
 *
 * @param modules - Fresh stores and panel of the case.
 * @param isStrict - Whether to render under StrictMode, which replays effects.
 * @returns Spies for opening and starting a conversation; both close history,
 * as the chat view does around them.
 */
function startHistoryParent(modules: HistoryPanelModules, isStrict = false) {
  const { useConversationHistoryStore, ConversationHistoryPanel } = modules
  const onOpenConversation = vi.fn<(conversationId: string) => void>(() => {
    useConversationHistoryStore.getState().closeConversationHistory()
  })
  const onStartConversation = vi.fn(() => {
    useConversationHistoryStore.getState().closeConversationHistory()
  })

  /**
   * Shows the panel while history is open.
   *
   * @returns The opener, an unrelated paragraph, and the open panel.
   */
  function HistoryParent() {
    const visibility = useConversationHistoryStore((state) => state.visibility)
    return (
      <>
        <button type="button">Opener</button>
        <p>Outside</p>
        {visibility.status === "open" ? (
          <ConversationHistoryPanel
            onOpenConversation={onOpenConversation}
            onStartConversation={onStartConversation}
            referenceTimeMs={visibility.openedAtMs}
          />
        ) : null}
      </>
    )
  }

  render(
    isStrict ? (
      <StrictMode>
        <HistoryParent />
      </StrictMode>
    ) : (
      <HistoryParent />
    )
  )
  return { onOpenConversation, onStartConversation }
}

/**
 * Opens history from the opener and waits for its first page.
 *
 * @param modules - Fresh stores and panel of the case.
 */
async function openHistoryFromOpener(
  modules: HistoryPanelModules
): Promise<void> {
  screen.getByRole("button", { name: "Opener" }).focus()
  await act(async () => {
    modules.useConversationHistoryStore.getState().openConversationHistory()
    await waitForMicrotasks()
  })
}

/**
 * Starts a backend listing the given conversations, renders the panel's
 * parent, and opens history from the opener.
 *
 * @param conversations - Stored conversations, newest first.
 * @param routes - Routes the case needs afterwards.
 * @returns The modules, the parent's spies, and the backend handle.
 */
async function openHistoryPanel(
  conversations: readonly ConversationSummary[] = [TRIP, RECIPE],
  routes: BackendRoutes = {}
) {
  const backend = startBackendFake({
    [LIST_ROUTE]: buildSearchingListRoute(conversations),
    ...routes
  })
  const modules = await loadFreshHistoryPanel()
  const parent = startHistoryParent(modules)
  await openHistoryFromOpener(modules)
  return { ...modules, ...parent, backend }
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
 * Gets the open button of a listed conversation.
 *
 * @param title - Displayed title, which starts its name.
 * @returns The open button.
 */
function getOpenButton(title: string): HTMLElement {
  return screen.getByRole("button", { name: new RegExp(`^${title}`) })
}

/**
 * Gets the search box.
 *
 * @returns The labelled search box.
 */
function getSearchBox(): HTMLElement {
  return screen.getByRole("searchbox", { name: "recall past conversations" })
}

afterEach(() => {
  vi.useRealTimers()
})

describe("ConversationHistoryPanel", () => {
  describe("dialog behavior", () => {
    it("opens as a dialog named Past conversations, focusing its search over the listed conversations", async () => {
      await openHistoryPanel()

      expect(
        screen.getByRole("dialog", { name: "Past conversations" })
      ).toBeInTheDocument()
      expect(getSearchBox()).toHaveFocus()
      expect(getOpenButton("Trip")).toBeInTheDocument()
      expect(getOpenButton("Recipe")).toBeInTheDocument()
      expect(screen.getByText("2 kept")).toBeInTheDocument()
    })

    it("closes on Escape from inside and returns focus to its opener", async () => {
      const { useConversationHistoryStore } = await openHistoryPanel()
      const user = userEvent.setup()
      getOpenButton("Recipe").focus()

      await user.keyboard("{Escape}")

      expect(useConversationHistoryStore.getState().visibility.status).toBe(
        "closed"
      )
      expect(screen.queryByRole("dialog")).toBeNull()
      expect(screen.getByRole("button", { name: "Opener" })).toHaveFocus()
    })

    it("returns focus to its opener after StrictMode replays its effects", async () => {
      startBackendFake({ [LIST_ROUTE]: buildSearchingListRoute([TRIP]) })
      const modules = await loadFreshHistoryPanel()
      startHistoryParent(modules, true)
      await openHistoryFromOpener(modules)
      const user = userEvent.setup()

      await user.keyboard("{Escape}")

      expect(screen.queryByRole("dialog")).toBeNull()
      expect(screen.getByRole("button", { name: "Opener" })).toHaveFocus()
    })

    it("closes on a pointer press outside it, but not on one inside", async () => {
      const { useConversationHistoryStore } = await openHistoryPanel()

      fireEvent.pointerDown(getOpenButton("Trip"))
      expect(useConversationHistoryStore.getState().visibility.status).toBe(
        "open"
      )

      act(() => {
        fireEvent.pointerDown(screen.getByText("Outside"))
      })
      expect(useConversationHistoryStore.getState().visibility.status).toBe(
        "closed"
      )
    })

    it("closes when focus moves to an element outside it, leaving focus there", async () => {
      const { useConversationHistoryStore } = await openHistoryPanel()
      const opener = screen.getByRole("button", { name: "Opener" })

      act(() => {
        opener.focus()
      })

      expect(useConversationHistoryStore.getState().visibility.status).toBe(
        "closed"
      )
      expect(opener).toHaveFocus()
    })

    it("starts a new conversation from its footer", async () => {
      const { onStartConversation } = await openHistoryPanel()
      const user = userEvent.setup()

      await user.click(screen.getByRole("button", { name: "Start a new one" }))

      expect(onStartConversation).toHaveBeenCalledOnce()
    })

    it("marks the conversation the chat view presents, or the one it is opening", async () => {
      const { useChatViewStore } = await openHistoryPanel()

      act(() => {
        useChatViewStore.setState({
          conversation: createStoredChatViewConversation(
            buildConversation(TRIP.id, "Trip", [
              buildUserMessage(4, "Plan a trip")
            ])
          )
        })
      })
      expect(getOpenButton("Trip")).toHaveAttribute("aria-current", "true")

      act(() => {
        useChatViewStore.setState({
          conversationOpen: {
            status: "opening",
            conversationId: RECIPE.id,
            replacedComposerDraft: ""
          }
        })
      })
      expect(getOpenButton("Recipe")).toHaveAttribute("aria-current", "true")
      expect(getOpenButton("Trip")).not.toHaveAttribute("aria-current")
    })
  })

  describe("opening from the search", () => {
    it("reads a search still waiting for a pause, then opens its first conversation", async () => {
      const { onOpenConversation, backend } = await openHistoryPanel()
      const user = userEvent.setup()

      await user.type(getSearchBox(), "rec{Enter}")
      await waitForRenderedWork()

      expect(onOpenConversation).toHaveBeenCalledExactlyOnceWith(RECIPE.id)
      expect(
        backend.requests.map((request) =>
          new URL(request.url).searchParams.get("query")
        )
      ).toEqual([null, "rec"])
    })

    it("opens nothing when the search finds no conversation", async () => {
      const { onOpenConversation, useConversationHistoryStore } =
        await openHistoryPanel()
      const user = userEvent.setup()

      await user.type(getSearchBox(), "zebra{Enter}")
      await waitForRenderedWork()

      expect(onOpenConversation).not.toHaveBeenCalled()
      expect(screen.getByText("Nothing matches that.")).toBeInTheDocument()
      act(() => {
        useConversationHistoryStore.getState().closeConversationHistory()
      })
    })
  })

  describe("changes", () => {
    it("renames a conversation in place and explains the editing keys meanwhile", async () => {
      const { backend } = await openHistoryPanel([TRIP, RECIPE], {
        [RENAME_TRIP_ROUTE]: () =>
          buildJsonResponse(200, buildConversationMetadata(TRIP.id, "Tour"))
      })
      const user = userEvent.setup()

      await user.click(screen.getByRole("button", { name: "Rename Trip" }))
      expect(
        screen.getByText("Enter saves · ESC cancels · Up to 120 characters")
      ).toBeInTheDocument()
      const field = screen.getByRole("textbox", { name: "rename conversation" })
      await user.clear(field)
      await user.type(field, "Tour{Enter}")
      await waitForRenderedWork()

      expect(backend.requests.at(-1)?.body).toEqual({ title: "Tour" })
      expect(getOpenButton("Tour")).toHaveFocus()
      expect(
        screen.getByText("Arrows move · Enter continues · F2 renames")
      ).toBeInTheDocument()
    })

    it("deletes a conversation after confirmation", async () => {
      await openHistoryPanel([TRIP, RECIPE], {
        [DELETE_TRIP_ROUTE]: () => new Response(null, { status: 204 })
      })
      const user = userEvent.setup()

      await user.click(screen.getByRole("button", { name: "Delete Trip" }))
      expect(
        screen.getByText("Deleting cannot be undone · ESC keeps it")
      ).toBeInTheDocument()
      await user.click(screen.getByRole("button", { name: "Delete" }))
      await waitForRenderedWork()

      expect(screen.queryByRole("button", { name: /^Trip/ })).toBeNull()
      expect(getOpenButton("Recipe")).toHaveFocus()
    })

    it("announces a change that failed in its footer", async () => {
      await openHistoryPanel([TRIP, RECIPE], {
        [RENAME_TRIP_ROUTE]: () => new Response(null, { status: 500 })
      })
      const user = userEvent.setup()

      await user.click(screen.getByRole("button", { name: "Rename Trip" }))
      await user.type(
        screen.getByRole("textbox", { name: "rename conversation" }),
        "!{Enter}"
      )
      await waitForRenderedWork()

      expect(screen.getByText(/^Renaming/)).toHaveAttribute("role", "status")
    })

    it("drops an edit whose conversation the displayed search no longer lists", async () => {
      vi.useFakeTimers()
      await openHistoryPanel()

      fireEvent.click(screen.getByRole("button", { name: "Rename Trip" }))
      expect(
        screen.getByRole("textbox", { name: "rename conversation" })
      ).toBeInTheDocument()
      fireEvent.change(getSearchBox(), { target: { value: "rec" } })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200)
      })

      expect(
        screen.queryByRole("textbox", { name: "rename conversation" })
      ).toBeNull()
      expect(
        screen.getByText("Arrows move · Enter continues · F2 renames")
      ).toBeInTheDocument()
    })
  })
})
