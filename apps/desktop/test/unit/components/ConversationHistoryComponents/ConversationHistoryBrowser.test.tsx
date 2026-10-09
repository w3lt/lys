import { useRef, useState } from "react"
import { fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import ConversationHistoryBrowser from "@/components/ConversationHistoryComponents/ConversationHistoryBrowser"
import {
  NO_ROW_INTERACTION,
  type ConversationHistoryListState,
  type ConversationHistoryMutation,
  type ConversationRowInteraction
} from "@/lib/store/conversation-history"
import { buildConversationHistoryPage } from "@/lib/store/conversation-history/history-list"
import {
  buildConversationListPage,
  buildConversationSummary,
  createFixtureUuidV7
} from "../../support/conversationFixtures"

/** History opened at 9 October 2026, 14:30 local time. */
const OPENED_AT_MS = new Date(2026, 9, 9, 14, 30).getTime()

/** Identity of the newest listed conversation. */
const NEWEST_ID = createFixtureUuidV7(3)

/** Identity of the middle listed conversation. */
const MIDDLE_ID = createFixtureUuidV7(2)

/** Identity of the oldest listed conversation. */
const OLDEST_ID = createFixtureUuidV7(1)

/**
 * Builds a displayed list of three conversations: two today and one
 * yesterday, newest first.
 *
 * @param query - Parsed query the page answers.
 * @param activity - Work replacing or extending the page.
 * @returns The loaded list.
 */
function buildThreeConversationList(
  query = "",
  activity: Extract<
    ConversationHistoryListState,
    { status: "loaded" }
  >["activity"] = {
    status: "idle"
  }
): ConversationHistoryListState {
  const summaries = [
    buildConversationSummary(
      NEWEST_ID,
      "Streaming pipeline",
      { role: "user", content: "Sketch the lys pipeline" },
      new Date(2026, 9, 9, 14, 0).toISOString()
    ),
    buildConversationSummary(
      MIDDLE_ID,
      null,
      null,
      new Date(2026, 9, 9, 9, 0).toISOString()
    ),
    buildConversationSummary(
      OLDEST_ID,
      "Context window",
      { role: "assistant", content: "It fills up" },
      new Date(2026, 9, 8, 20, 0).toISOString()
    )
  ]
  return {
    status: "loaded",
    page: buildConversationHistoryPage(
      query,
      buildConversationListPage(summaries, { nextCursor: "older" })
    ),
    activity
  }
}

/** Domain actions the browser requests from its parent. */
type BrowserActions = ReturnType<typeof buildBrowserActions>

/**
 * Builds spies for every action the browser requests.
 *
 * @returns The spies.
 */
function buildBrowserActions() {
  return {
    onQueryChange: vi.fn(),
    onRowInteractionChange: vi.fn(),
    onOpenConversation: vi.fn(),
    onOpenFirstConversation: vi.fn(),
    onUpdateConversationTitle: vi.fn(),
    onDeleteConversation: vi.fn(),
    onRetryConversationHistory: vi.fn(),
    onLoadOlderConversations: vi.fn(),
    onCloseConversationHistory: vi.fn()
  }
}

/** Properties of {@link BrowserHarness}. */
type BrowserHarnessProps = Readonly<{
  list: ConversationHistoryListState
  actions: BrowserActions
  query?: string
  pendingMutations?: readonly ConversationHistoryMutation[]
  openConversationId?: string
}>

/**
 * Plays the parent that owns the row interaction, accepting every proposal
 * the browser makes, as the history store does.
 *
 * @param props - List, action spies, and the facts a case varies.
 * @returns The browser under that parent.
 */
function BrowserHarness({
  list,
  actions,
  query = "",
  pendingMutations = [],
  openConversationId
}: BrowserHarnessProps) {
  const [rowInteraction, setRowInteraction] =
    useState<ConversationRowInteraction>(NO_ROW_INTERACTION)
  const searchFieldRef = useRef<HTMLInputElement>(null)
  return (
    <ConversationHistoryBrowser
      {...actions}
      hintId="history-hint"
      list={list}
      onRowInteractionChange={(next) => {
        actions.onRowInteractionChange(next)
        setRowInteraction(next)
      }}
      openConversationId={openConversationId}
      pendingMutations={pendingMutations}
      query={query}
      referenceTimeMs={OPENED_AT_MS}
      rowInteraction={rowInteraction}
      searchFieldRef={searchFieldRef}
    />
  )
}

/**
 * Renders the browser under the accepting parent.
 *
 * @param props - List and the facts a case varies.
 * @returns The action spies.
 */
function renderBrowser(
  props: Omit<BrowserHarnessProps, "actions"> = {
    list: buildThreeConversationList()
  }
): BrowserActions {
  const actions = buildBrowserActions()
  render(<BrowserHarness {...props} actions={actions} />)
  return actions
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

/**
 * Gets the scrollable result region, which carries the documented busy
 * state while rows are replaced.
 *
 * @returns The region holding the rows.
 */
function getResultRegion(): HTMLElement {
  const region =
    getOpenButton("Streaming pipeline").closest<HTMLElement>("div[aria-busy]")
  if (region === null) throw new Error("The rows are outside a result region")
  return region
}

/**
 * Scrolls the result region to a position.
 *
 * @param region - Result region.
 * @param remainingPx - Distance left between the visible end and the list end.
 * @remarks jsdom lays nothing out, so the region's measurements are set to
 * the values a scrolled list would report.
 */
function scrollResults(region: HTMLElement, remainingPx: number): void {
  Object.defineProperty(region, "scrollHeight", {
    configurable: true,
    value: 1000
  })
  Object.defineProperty(region, "clientHeight", {
    configurable: true,
    value: 400
  })
  Object.defineProperty(region, "scrollTop", {
    configurable: true,
    value: 600 - remainingPx
  })
  fireEvent.scroll(region)
}

describe("ConversationHistoryBrowser", () => {
  describe("listing", () => {
    it("groups the rows by day in list order", () => {
      renderBrowser()

      const today = screen.getByRole("group", { name: "Today" })
      const yesterday = screen.getByRole("group", { name: "Yesterday" })
      expect(
        within(today)
          .getAllByRole("listitem")
          .map((row) => within(row).getAllByRole("button")[0].textContent)
      ).toEqual([
        "Streaming pipelineyou: Sketch the lys pipeline30m",
        "Untitledno messages09:00"
      ])
      expect(within(yesterday).getAllByRole("listitem")).toHaveLength(1)
      expect(screen.queryByRole("group", { name: "Earlier" })).toBeNull()
    })

    it.each<[string, ConversationHistoryListState, string]>([
      [
        "before the list is read",
        { status: "idle" },
        "Reading past conversations…"
      ],
      [
        "while the list is read",
        { status: "loading" },
        "Reading past conversations…"
      ],
      [
        "when nothing is kept",
        {
          status: "loaded",
          page: buildConversationHistoryPage("", buildConversationListPage([])),
          activity: { status: "idle" }
        },
        "Nothing kept. The next thing you send starts a conversation."
      ],
      [
        "when nothing matches",
        {
          status: "loaded",
          page: buildConversationHistoryPage(
            "zebra",
            buildConversationListPage([], { storedCount: 3 })
          ),
          activity: { status: "idle" }
        },
        "Nothing matches that."
      ]
    ])("shows a notice instead of rows %s", (_case, list, message) => {
      renderBrowser({ list })

      expect(screen.getByText(message)).toBeInTheDocument()
      expect(screen.queryByRole("listitem")).toBeNull()
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull()
    })

    it("shows a failed read and retries it on request", async () => {
      const actions = renderBrowser({
        list: {
          status: "failed",
          error: "Past conversations could not be read."
        }
      })
      const user = userEvent.setup()

      expect(
        screen.getByText("Past conversations could not be read.")
      ).toBeInTheDocument()
      await user.click(screen.getByRole("button", { name: "Try again" }))

      expect(actions.onRetryConversationHistory).toHaveBeenCalledOnce()
    })

    it("highlights the query the displayed page answers, not the text being typed", () => {
      const { container } = render(
        <BrowserHarness
          actions={buildBrowserActions()}
          list={buildThreeConversationList("lys")}
          query="lys pipe"
        />
      )

      const marks = container.querySelectorAll("mark")
      expect(marks).toHaveLength(1)
      expect(marks[0]?.textContent).toBe("lys")
      expect(getSearchBox()).toHaveValue("lys pipe")
    })

    it("marks the region busy while its rows are being replaced", () => {
      renderBrowser({
        list: buildThreeConversationList("", { status: "refreshing" })
      })

      expect(getResultRegion()).toHaveAttribute("aria-busy", "true")
    })

    it.each<
      [
        string,
        Extract<ConversationHistoryListState, { status: "loaded" }>["activity"],
        string
      ]
    >([
      ["reading", { status: "loading-older" }, "Reading older conversations…"],
      [
        "failing",
        {
          status: "older-failed",
          error: "Older conversations could not be read."
        },
        "Older conversations could not be read. Scroll to the end to try again."
      ]
    ])(
      "announces older entries %s after the rows",
      (_case, activity, message) => {
        renderBrowser({ list: buildThreeConversationList("", activity) })

        expect(screen.getByText(message)).toHaveAttribute("role", "status")
      }
    )

    it("marks the conversation the chat view presents and the changes still pending", () => {
      renderBrowser({
        list: buildThreeConversationList(),
        openConversationId: MIDDLE_ID,
        pendingMutations: [{ conversationId: OLDEST_ID, operation: "delete" }]
      })

      expect(getOpenButton("Untitled")).toHaveAttribute("aria-current", "true")
      expect(getOpenButton("Context window")).toBeDisabled()
      expect(screen.getByText("deleting…")).toBeInTheDocument()
    })
  })

  describe("opening", () => {
    it("opens the pressed conversation", async () => {
      const actions = renderBrowser()
      const user = userEvent.setup()

      await user.click(getOpenButton("Untitled"))

      expect(actions.onOpenConversation).toHaveBeenCalledExactlyOnceWith(
        MIDDLE_ID
      )
    })

    it("opens the first conversation for the search on Enter in it", () => {
      const actions = renderBrowser()

      fireEvent.keyDown(getSearchBox(), { key: "Enter" })

      expect(actions.onOpenFirstConversation).toHaveBeenCalledOnce()
    })

    it("opens a row reached with Arrow Down on Enter", async () => {
      const actions = renderBrowser()
      const user = userEvent.setup()
      getSearchBox().focus()

      await user.keyboard("{ArrowDown}{Enter}")

      expect(getOpenButton("Streaming pipeline")).toHaveFocus()
      expect(actions.onOpenConversation).toHaveBeenCalledExactlyOnceWith(
        NEWEST_ID
      )
    })
  })

  describe("keyboard movement", () => {
    it("moves down the rows from the search and back up to it", async () => {
      renderBrowser()
      const user = userEvent.setup()
      getSearchBox().focus()

      await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}")
      expect(getOpenButton("Context window")).toHaveFocus()

      await user.keyboard("{ArrowUp}{ArrowUp}{ArrowUp}")
      expect(getSearchBox()).toHaveFocus()
    })

    it("asks for older conversations on Arrow Down from the last row", async () => {
      const actions = renderBrowser()
      const user = userEvent.setup()
      getOpenButton("Context window").focus()

      await user.keyboard("{ArrowDown}")

      expect(actions.onLoadOlderConversations).toHaveBeenCalledOnce()
      expect(getOpenButton("Context window")).toHaveFocus()
    })

    it("skips a row whose deletion is pending", async () => {
      renderBrowser({
        list: buildThreeConversationList(),
        pendingMutations: [{ conversationId: MIDDLE_ID, operation: "delete" }]
      })
      const user = userEvent.setup()
      getOpenButton("Streaming pipeline").focus()

      await user.keyboard("{ArrowDown}")
      expect(getOpenButton("Context window")).toHaveFocus()

      await user.keyboard("{ArrowUp}")
      expect(getOpenButton("Streaming pipeline")).toHaveFocus()
    })
  })

  describe("scrolling", () => {
    it("asks for older conversations each time a scroll ends near the list end", () => {
      const actions = renderBrowser()
      const region = getResultRegion()

      scrollResults(region, 300)
      expect(actions.onLoadOlderConversations).not.toHaveBeenCalled()

      scrollResults(region, 40)
      scrollResults(region, 10)
      expect(actions.onLoadOlderConversations).toHaveBeenCalledTimes(2)
    })

    it("after an older read failed, retries only on arriving at the end again", () => {
      const actions = renderBrowser({
        list: buildThreeConversationList("", {
          status: "older-failed",
          error: "Older conversations could not be read."
        })
      })
      const region = getResultRegion()

      scrollResults(region, 10)
      scrollResults(region, 5)
      expect(actions.onLoadOlderConversations).toHaveBeenCalledOnce()

      scrollResults(region, 300)
      scrollResults(region, 10)
      expect(actions.onLoadOlderConversations).toHaveBeenCalledTimes(2)
    })
  })

  describe("renaming", () => {
    it("edits the title in place and saves a changed one, returning focus to the row", async () => {
      const actions = renderBrowser()
      const user = userEvent.setup()

      await user.click(
        screen.getByRole("button", { name: "Rename Streaming pipeline" })
      )
      const field = screen.getByRole("textbox", { name: "rename conversation" })
      expect(field).toHaveFocus()
      expect(field).toHaveValue("Streaming pipeline")

      await user.clear(field)
      await user.type(field, "  Pipeline sketch  {Enter}")

      expect(actions.onUpdateConversationTitle).toHaveBeenCalledExactlyOnceWith(
        NEWEST_ID,
        "Pipeline sketch"
      )
      expect(
        screen.queryByRole("textbox", { name: "rename conversation" })
      ).toBeNull()
      expect(getOpenButton("Streaming pipeline")).toHaveFocus()
    })

    it("starts an untitled conversation's edit empty", async () => {
      renderBrowser()
      const user = userEvent.setup()

      await user.click(screen.getByRole("button", { name: "Rename Untitled" }))

      expect(
        screen.getByRole("textbox", { name: "rename conversation" })
      ).toHaveValue("")
    })

    it.each([
      ["an unchanged", "Streaming pipeline"],
      ["a blank", "   "]
    ])("does not save %s title", async (_case, typed) => {
      const actions = renderBrowser()
      const user = userEvent.setup()
      await user.click(
        screen.getByRole("button", { name: "Rename Streaming pipeline" })
      )
      const field = screen.getByRole("textbox", { name: "rename conversation" })

      await user.clear(field)
      await user.type(field, `${typed}{Enter}`)

      expect(actions.onUpdateConversationTitle).not.toHaveBeenCalled()
      expect(getOpenButton("Streaming pipeline")).toHaveFocus()
    })

    it("cancels on Escape, returning focus to the row without saving", async () => {
      const actions = renderBrowser()
      const user = userEvent.setup()
      await user.click(
        screen.getByRole("button", { name: "Rename Streaming pipeline" })
      )

      await user.type(
        screen.getByRole("textbox", { name: "rename conversation" }),
        "!{Escape}"
      )

      expect(actions.onUpdateConversationTitle).not.toHaveBeenCalled()
      expect(actions.onCloseConversationHistory).not.toHaveBeenCalled()
      expect(getOpenButton("Streaming pipeline")).toHaveFocus()
    })

    it("saves a changed title when focus moves elsewhere", async () => {
      const actions = renderBrowser()
      const user = userEvent.setup()
      await user.click(
        screen.getByRole("button", { name: "Rename Streaming pipeline" })
      )
      await user.type(
        screen.getByRole("textbox", { name: "rename conversation" }),
        "!"
      )

      await user.click(getSearchBox())

      expect(actions.onUpdateConversationTitle).toHaveBeenCalledExactlyOnceWith(
        NEWEST_ID,
        "Streaming pipeline!"
      )
      expect(getSearchBox()).toHaveFocus()
    })

    it("starts renaming the focused row on F2", async () => {
      renderBrowser()
      const user = userEvent.setup()
      getOpenButton("Context window").focus()

      await user.keyboard("{F2}")

      expect(
        screen.getByRole("textbox", { name: "rename conversation" })
      ).toHaveValue("Context window")
    })
  })

  describe("deleting", () => {
    it("asks first, then deletes and moves focus to the next row", async () => {
      const actions = renderBrowser()
      const user = userEvent.setup()

      await user.click(
        screen.getByRole("button", { name: "Delete Streaming pipeline" })
      )
      expect(screen.getByRole("button", { name: "Keep" })).toHaveFocus()
      await user.click(screen.getByRole("button", { name: "Delete" }))

      expect(actions.onDeleteConversation).toHaveBeenCalledExactlyOnceWith(
        NEWEST_ID
      )
      expect(getOpenButton("Untitled")).toHaveFocus()
    })

    it("prefers the next row over the previous one", async () => {
      renderBrowser()
      const user = userEvent.setup()

      await user.click(screen.getByRole("button", { name: "Delete Untitled" }))
      await user.click(screen.getByRole("button", { name: "Delete" }))

      expect(getOpenButton("Context window")).toHaveFocus()
    })

    it("moves focus to the previous row after deleting the last one", async () => {
      renderBrowser()
      const user = userEvent.setup()

      await user.click(
        screen.getByRole("button", { name: "Delete Context window" })
      )
      await user.click(screen.getByRole("button", { name: "Delete" }))

      expect(getOpenButton("Untitled")).toHaveFocus()
    })

    it("moves focus to the search after deleting the only row", async () => {
      renderBrowser({
        list: {
          status: "loaded",
          page: buildConversationHistoryPage(
            "",
            buildConversationListPage([
              buildConversationSummary(NEWEST_ID, "Only", null)
            ])
          ),
          activity: { status: "idle" }
        }
      })
      const user = userEvent.setup()

      await user.click(screen.getByRole("button", { name: "Delete Only" }))
      await user.click(screen.getByRole("button", { name: "Delete" }))

      expect(getSearchBox()).toHaveFocus()
    })

    it("keeps the conversation and returns focus to its row", async () => {
      const actions = renderBrowser()
      const user = userEvent.setup()
      await user.click(screen.getByRole("button", { name: "Delete Untitled" }))

      await user.click(screen.getByRole("button", { name: "Keep" }))

      expect(actions.onDeleteConversation).not.toHaveBeenCalled()
      expect(getOpenButton("Untitled")).toHaveFocus()
    })
  })
})
