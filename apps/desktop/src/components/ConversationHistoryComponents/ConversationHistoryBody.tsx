import type { ReactElement } from "react"

import { Button } from "@/components/ui/button"
import type {
  ConversationHistoryListState,
  ConversationHistoryOperationState
} from "@/lib/store/conversation-history"

import { createConversationHistoryGroups } from "./conversation-history-presentation"
import {
  ConversationHistoryList,
  type ConversationRowInteraction
} from "./ConversationHistoryList"
import type { ConversationRowActions } from "./ConversationHistoryRow"

/** Properties accepted by {@link ConversationHistoryBody}. */
export type ConversationHistoryBodyProps = {
  /** Authoritative list lifecycle rendered by this region. */
  readonly list: ConversationHistoryListState
  /** Current search text, used to mark matches and select the empty state. */
  readonly searchQuery: string
  /** Conversation open in the chat view, or undefined when none is. */
  readonly activeConversationId?: string
  /** The single row-level interaction currently presented. */
  readonly rowInteraction: ConversationRowInteraction
  /** Conversation operation currently running, if any. */
  readonly operation: ConversationHistoryOperationState
  /** Panel-owned actions offered by every rendered row. */
  readonly actions: ConversationRowActions
  /** Requests that the panel read the first page again after a failure. */
  readonly onLoadConversations: () => void
  /** Requests that the panel append the next page of conversations. */
  readonly onLoadNextConversationPage: () => void
}

/**
 * Presents the list region in its pending, failed, or loaded state.
 *
 * @remarks Primary category: presentational. It renders exactly one branch of
 * the authoritative list state supplied by the panel and owns no state, effect,
 * or application dependency. Pending, empty, and failed states are distinct: a
 * failed first load replaces the list and offers a real retry, while a failed
 * further page keeps the conversations already loaded and reports the failure
 * beneath them. The next-page control is present only while the backend reports
 * a further page.
 * @param props - List lifecycle, list projection inputs, panel-owned row
 * actions, and the panel-owned load actions.
 * @returns The pending, failed, or loaded list region.
 */
export function ConversationHistoryBody({
  list,
  searchQuery,
  activeConversationId,
  rowInteraction,
  operation,
  actions,
  onLoadConversations,
  onLoadNextConversationPage
}: ConversationHistoryBodyProps): ReactElement {
  if (list.status === "idle" || list.status === "loading") {
    return (
      <p className="conversation-history__loading" role="status">
        Reading your conversations…
      </p>
    )
  }

  if (list.status === "failed") {
    return (
      <div className="conversation-history__failure">
        <p role="alert">{list.error}</p>
        <Button
          onClick={onLoadConversations}
          size="sm"
          type="button"
          variant="outline"
        >
          Try again
        </Button>
      </div>
    )
  }

  return (
    <>
      <ConversationHistoryList
        actions={actions}
        activeConversationId={activeConversationId}
        groups={createConversationHistoryGroups(list.page)}
        listedAt={list.page.listedAt}
        operation={operation}
        rowInteraction={rowInteraction}
        searchQuery={searchQuery}
      />

      {list.status === "next-page-failed" && (
        <p className="conversation-history__page-error" role="alert">
          {list.error}
        </p>
      )}

      {list.page.nextCursor !== null && (
        <div className="conversation-history__more">
          <Button
            disabled={list.status === "loading-next-page"}
            onClick={onLoadNextConversationPage}
            size="sm"
            type="button"
            variant="ghost"
          >
            {list.status === "loading-next-page"
              ? "Loading older conversations…"
              : "Load older conversations"}
          </Button>
        </div>
      )}
    </>
  )
}
