import { useId, useRef } from "react"
import type { ReactElement, RefCallback, RefObject, UIEvent } from "react"

import type {
  ConversationHistoryEntry,
  ConversationHistoryListState,
  ConversationHistoryMutation
} from "@/lib/store/conversation-history"

import ConversationDeleteConfirmRow from "./ConversationDeleteConfirmRow"
import ConversationHistoryNotice from "./ConversationHistoryNotice"
import ConversationHistoryRow from "./ConversationHistoryRow"
import ConversationSearchField from "./ConversationSearchField"
import ConversationTitleEditRow from "./ConversationTitleEditRow"
import {
  buildConversationHistoryGroups,
  type ConversationHistoryGroup,
  type ConversationRowInteraction,
  formatConversationHistoryCount,
  formatConversationTitle,
  NO_ROW_INTERACTION
} from "./conversation-history-presentation"

/** Properties accepted by {@link ConversationHistoryBrowser}. */
export type ConversationHistoryBrowserProps = {
  /** Search text owned by the parent, shown exactly as typed. */
  readonly query: string
  /** Lifecycle of the displayed conversation list. */
  readonly list: ConversationHistoryListState
  /** Epoch milliseconds relative times and day groups are measured from. */
  readonly referenceTimeMs: number
  /** Conversation the chat view presents or is opening, if any. */
  readonly openConversationId: string | undefined
  /** Changes awaiting their backend outcome. */
  readonly pendingMutations: readonly ConversationHistoryMutation[]
  /** Parent-owned row interaction currently in progress. */
  readonly rowInteraction: ConversationRowInteraction
  /** Identifier of the visible hint describing keyboard use. */
  readonly hintId: string
  /** Parent-owned ref to the search input. */
  readonly searchFieldRef: RefObject<HTMLInputElement | null>
  /** Receives a proposed replacement for the parent-owned search text. */
  readonly onQueryChange: (query: string) => void
  /** Receives a proposed replacement for the parent-owned row interaction. */
  readonly onRowInteractionChange: (
    rowInteraction: ConversationRowInteraction
  ) => void
  /** Requests that the parent open a conversation in the chat view. */
  readonly onOpenConversation: (conversationId: string) => void
  /** Requests that the parent persist a changed, trimmed, non-empty title. */
  readonly onUpdateConversationTitle: (
    conversationId: string,
    title: string
  ) => void
  /** Requests that the parent permanently delete a conversation. */
  readonly onDeleteConversation: (conversationId: string) => void
  /** Requests that the parent read the list again after a failure. */
  readonly onRetryConversationHistory: () => void
  /** Requests that the parent read the next older page, if any. */
  readonly onLoadOlderConversations: () => void
  /** Requests that the parent close conversation history. */
  readonly onCloseConversationHistory: () => void
}

/** Shared empty entry list used before a page is displayed. */
const NO_ENTRIES: readonly ConversationHistoryEntry[] = Object.freeze([])

/** Distance from the list end, in CSS pixels, that triggers an older read. */
const OLDER_PAGE_SCROLL_THRESHOLD_PX = 48

/**
 * Selects the row change awaiting its outcome for one conversation.
 *
 * @param mutations - Changes awaiting their outcome.
 * @param conversationId - Conversation shown by the row.
 * @returns The pending operation, or `none`.
 */
function findPendingOperation(
  mutations: readonly ConversationHistoryMutation[],
  conversationId: string
): ConversationHistoryMutation["operation"] | "none" {
  const mutation = mutations.find(
    (pending) => pending.conversationId === conversationId
  )

  return mutation?.operation ?? "none"
}

/**
 * Formats the notice that replaces rows, when rows cannot be shown.
 *
 * @param list - Current list state.
 * @returns The notice message, or undefined when entries are displayed.
 */
function formatHistoryNoticeMessage(
  list: ConversationHistoryListState
): string | undefined {
  switch (list.status) {
    case "idle":
    case "loading":
      return "Reading past conversations…"
    case "failed":
      return list.error
    case "loaded":
      if (list.page.entries.length > 0) return undefined
      return list.page.query === ""
        ? "Nothing kept. The next thing you send starts a conversation."
        : "Nothing matches that."
  }
}

/**
 * Formats the status line shown after the rows while older entries matter.
 *
 * @param list - Current list state.
 * @returns Older-page progress or failure text, or empty text.
 */
function formatOlderPageStatus(list: ConversationHistoryListState): string {
  if (list.status !== "loaded") return ""

  switch (list.activity.status) {
    case "loading-older":
      return "Reading older conversations…"
    case "older-failed":
      return `${list.activity.error} Scroll to the end to try again.`
    case "idle":
    case "refreshing":
      return ""
  }
}

/**
 * Searches, browses, and changes past conversations from the keyboard or
 * pointer.
 *
 * @remarks Primary category: interactive feature. The parent owns the search
 * text, the list, pending changes, the row interaction, and every requested
 * domain action; this component owns only the open-button registry and the
 * pending focus request used to move focus. Rows are grouped by local calendar
 * day relative to
 * `referenceTimeMs` and keep list order. Arrow Down from the search moves to
 * the first openable row and Enter there opens it; Arrow Up and Arrow Down
 * move between rows, Arrow Up from the first row returns to the search, and
 * Arrow Down on the last row or scrolling near the end requests older
 * entries, which join any read already in progress. Renaming and confirming
 * deletion replace one row at a time. Submitting or cancelling a rename and
 * keeping a conversation return focus to that row; confirming deletion first
 * moves focus to the next row, the previous row, or the search. A title is
 * requested only when it changed and is not blank. Loading, empty, no-match,
 * and failure messages replace the rows, and the region is marked busy while
 * its rows are being replaced.
 * @param props - List state, interaction state, focus target, and actions.
 * @returns The search field followed by the scrollable result region.
 */
export default function ConversationHistoryBrowser({
  query,
  list,
  referenceTimeMs,
  openConversationId,
  pendingMutations,
  rowInteraction,
  hintId,
  searchFieldRef,
  onQueryChange,
  onRowInteractionChange,
  onOpenConversation,
  onUpdateConversationTitle,
  onDeleteConversation,
  onRetryConversationHistory,
  onLoadOlderConversations,
  onCloseConversationHistory
}: ConversationHistoryBrowserProps): ReactElement {
  const openButtonsRef = useRef(new Map<string, HTMLButtonElement>())
  const pendingFocusIdRef = useRef<string | undefined>(undefined)
  const groupIdPrefix = useId()
  const entries = list.status === "loaded" ? list.page.entries : NO_ENTRIES
  const highlightQuery = list.status === "loaded" ? list.page.query : ""
  const entryIds = entries.map((entry) => entry.id)
  const groups = buildConversationHistoryGroups(entries, referenceTimeMs)
  const noticeMessage = formatHistoryNoticeMessage(list)
  const isRefreshing =
    list.status === "loaded" && list.activity.status === "refreshing"

  /**
   * Creates the ref that registers one row's open button for focus movement.
   *
   * @param conversationId - Conversation shown by the row.
   * @returns A ref callback whose cleanup unregisters the button.
   */
  function createOpenButtonRef(
    conversationId: string
  ): RefCallback<HTMLButtonElement> {
    /**
     * Registers the attached open button until it detaches, and focuses it
     * when a focus request is waiting for this row.
     *
     * @param element - Attached open button.
     * @returns The cleanup that unregisters it.
     */
    function attachOpenButton(element: HTMLButtonElement | null): () => void {
      if (element !== null) {
        openButtonsRef.current.set(conversationId, element)
        if (pendingFocusIdRef.current === conversationId) {
          pendingFocusIdRef.current = undefined
          element.focus()
        }
      }
      return () => openButtonsRef.current.delete(conversationId)
    }

    return attachOpenButton
  }

  /**
   * Finds the nearest enabled open button from one list position.
   *
   * @param startIndex - First position examined.
   * @param step - Direction of the search through list order.
   * @returns The nearest enabled registered button, or undefined.
   */
  function findOpenButton(
    startIndex: number,
    step: 1 | -1
  ): HTMLButtonElement | undefined {
    for (
      let index = startIndex;
      index >= 0 && index < entryIds.length;
      index += step
    ) {
      const button = openButtonsRef.current.get(entryIds[index])
      if (button !== undefined && !button.disabled) return button
    }

    return undefined
  }

  /** Moves focus from the search field to the first openable row. */
  function handleSearchFieldArrowDown(): void {
    findOpenButton(0, 1)?.focus()
  }

  /** Opens the first listed conversation that is not being deleted. */
  function handleSearchFieldEnter(): void {
    const firstEntry = entries.find(
      (entry) => findPendingOperation(pendingMutations, entry.id) !== "delete"
    )
    if (firstEntry !== undefined) onOpenConversation(firstEntry.id)
  }

  /**
   * Moves focus to the next row, or requests older entries at the end.
   *
   * @param conversationId - Conversation whose row has focus.
   */
  function handleRowArrowDown(conversationId: string): void {
    const nextButton = findOpenButton(entryIds.indexOf(conversationId) + 1, 1)
    if (nextButton === undefined) {
      onLoadOlderConversations()
      return
    }

    nextButton.focus()
  }

  /**
   * Moves focus to the previous row, or to the search from the first row.
   *
   * @param conversationId - Conversation whose row has focus.
   */
  function handleRowArrowUp(conversationId: string): void {
    const previousButton = findOpenButton(
      entryIds.indexOf(conversationId) - 1,
      -1
    )
    if (previousButton === undefined) {
      searchFieldRef.current?.focus()
      return
    }

    previousButton.focus()
  }

  /**
   * Requests older entries once the list is scrolled near its end.
   *
   * @param event - Scroll of the result region.
   */
  function handleResultsScroll(event: UIEvent<HTMLDivElement>): void {
    const region = event.currentTarget
    const remainingPx =
      region.scrollHeight - region.scrollTop - region.clientHeight
    if (remainingPx < OLDER_PAGE_SCROLL_THRESHOLD_PX) onLoadOlderConversations()
  }

  /**
   * Ends the title edit and requests a changed, non-blank title.
   *
   * @param entry - Conversation whose title was edited.
   * @param draftTitle - Draft reported by the title field.
   */
  function saveTitleDraft(
    entry: ConversationHistoryEntry,
    draftTitle: string
  ): void {
    const title = draftTitle.trim()
    onRowInteractionChange(NO_ROW_INTERACTION)
    if (title !== "" && title !== entry.title) {
      onUpdateConversationTitle(entry.id, title)
    }
  }

  /**
   * Ends the row interaction and returns focus to that row's open button.
   *
   * @param conversationId - Conversation whose row regains focus.
   * @param endInteraction - State change that ends the interaction.
   * @remarks The open button does not exist while its row is editing or
   * confirming, so focus is requested here and taken when the button attaches.
   * The commit that ends the interaction always renders that button, because
   * only a displayed row can end its interaction.
   */
  function handleRowInteractionEnd(
    conversationId: string,
    endInteraction: () => void
  ): void {
    pendingFocusIdRef.current = conversationId
    endInteraction()
  }

  /**
   * Moves focus away from a row, then requests its deletion.
   *
   * @param conversationId - Conversation confirmed for deletion.
   * @remarks Focus moves first, while the confirming row still holds it, so
   * it never falls to the document when that row is replaced.
   */
  function handleDeleteConfirm(conversationId: string): void {
    const index = entryIds.indexOf(conversationId)
    const successor =
      findOpenButton(index + 1, 1) ??
      findOpenButton(index - 1, -1) ??
      searchFieldRef.current
    successor?.focus()
    onRowInteractionChange(NO_ROW_INTERACTION)
    onDeleteConversation(conversationId)
  }

  /**
   * Builds the in-place title editor for one entry.
   *
   * @param entry - Entry whose title is being edited.
   * @returns The title-editing list item.
   */
  function buildTitleEditRow(entry: ConversationHistoryEntry): ReactElement {
    return (
      <ConversationTitleEditRow
        excerpt={entry.excerpt}
        highlightQuery={highlightQuery}
        hintId={hintId}
        initialTitle={entry.title ?? ""}
        key={entry.id}
        onCancelTitleEdit={() =>
          handleRowInteractionEnd(entry.id, () =>
            onRowInteractionChange(NO_ROW_INTERACTION)
          )
        }
        onLeaveTitleField={(draftTitle) => saveTitleDraft(entry, draftTitle)}
        onSubmitTitle={(draftTitle) =>
          handleRowInteractionEnd(entry.id, () =>
            saveTitleDraft(entry, draftTitle)
          )
        }
      />
    )
  }

  /**
   * Builds the deletion prompt for one entry.
   *
   * @param entry - Entry awaiting deletion confirmation.
   * @returns The confirming list item.
   */
  function buildDeleteConfirmRow(
    entry: ConversationHistoryEntry
  ): ReactElement {
    return (
      <ConversationDeleteConfirmRow
        key={entry.id}
        onCancelDelete={() =>
          handleRowInteractionEnd(entry.id, () =>
            onRowInteractionChange(NO_ROW_INTERACTION)
          )
        }
        onConfirmDelete={() => handleDeleteConfirm(entry.id)}
        title={formatConversationTitle(entry)}
      />
    )
  }

  /**
   * Builds the ordinary row for one entry.
   *
   * @param entry - Entry to show.
   * @returns The list item with open, rename, and delete actions.
   */
  function buildEntryRow(entry: ConversationHistoryEntry): ReactElement {
    const editingInteraction: ConversationRowInteraction = {
      kind: "editing-title",
      conversationId: entry.id
    }
    const confirmingInteraction: ConversationRowInteraction = {
      kind: "confirming-delete",
      conversationId: entry.id
    }

    return (
      <ConversationHistoryRow
        entry={entry}
        highlightQuery={highlightQuery}
        isOpenInChat={entry.id === openConversationId}
        key={entry.id}
        onFocusNextConversation={() => handleRowArrowDown(entry.id)}
        onFocusPreviousConversation={() => handleRowArrowUp(entry.id)}
        onOpenConversation={() => onOpenConversation(entry.id)}
        onRequestDelete={() => onRowInteractionChange(confirmingInteraction)}
        onStartTitleEdit={() => onRowInteractionChange(editingInteraction)}
        openButtonRef={createOpenButtonRef(entry.id)}
        pendingOperation={findPendingOperation(pendingMutations, entry.id)}
        referenceTimeMs={referenceTimeMs}
      />
    )
  }

  /**
   * Builds the row for one entry in its current interaction mode.
   *
   * @param entry - Entry to show.
   * @returns The editing, confirming, or ordinary row.
   */
  function buildRow(entry: ConversationHistoryEntry): ReactElement {
    if (rowInteraction.kind === "none") return buildEntryRow(entry)
    if (rowInteraction.conversationId !== entry.id) return buildEntryRow(entry)

    return rowInteraction.kind === "editing-title"
      ? buildTitleEditRow(entry)
      : buildDeleteConfirmRow(entry)
  }

  /**
   * Builds one labeled calendar group of rows.
   *
   * @param group - Non-empty calendar group.
   * @returns The group, keyed by its label so removing or adding entries
   * never remounts the rows that remain.
   */
  function buildGroup(group: ConversationHistoryGroup): ReactElement {
    const labelId = `${groupIdPrefix}-${group.label}`

    return (
      <div
        aria-labelledby={labelId}
        className="conversation-history__group"
        key={group.label}
        role="group"
      >
        <p className="conversation-history__group-label" id={labelId}>
          {group.label}
        </p>
        <ul className="conversation-history__list">
          {group.entries.map(buildRow)}
        </ul>
      </div>
    )
  }

  /**
   * Builds the notice that replaces rows, when rows cannot be shown.
   *
   * @returns The failure or message notice, or null while rows are shown.
   */
  function buildNotice(): ReactElement | null {
    if (noticeMessage === undefined) return null
    if (list.status !== "failed") {
      return (
        <ConversationHistoryNotice kind="message" message={noticeMessage} />
      )
    }

    return (
      <ConversationHistoryNotice
        kind="failure"
        message={noticeMessage}
        onRetryConversationHistory={onRetryConversationHistory}
      />
    )
  }

  return (
    <>
      <ConversationSearchField
        hintId={hintId}
        onCloseConversationHistory={onCloseConversationHistory}
        onFocusFirstConversation={handleSearchFieldArrowDown}
        onOpenFirstConversation={handleSearchFieldEnter}
        onQueryChange={onQueryChange}
        query={query}
        resultCountLabel={formatConversationHistoryCount(list)}
        searchFieldRef={searchFieldRef}
      />
      <div
        aria-busy={isRefreshing}
        className="conversation-history__results"
        onScroll={handleResultsScroll}
      >
        {buildNotice()}
        {groups.map(buildGroup)}
        <p className="conversation-history__older" role="status">
          {formatOlderPageStatus(list)}
        </p>
      </div>
    </>
  )
}
