import type { ReactElement } from "react"

import type { ConversationHistoryOperationState } from "@/lib/store/conversation-history"

import type { ConversationHistoryGroup } from "./conversation-history-presentation"
import {
  ConversationHistoryRow,
  type ConversationHistoryRowActivity,
  type ConversationHistoryRowMode,
  type ConversationRowActions
} from "./ConversationHistoryRow"

/** The single row-level interaction the history panel presents at a time. */
export type ConversationRowInteraction =
  | {
      /** No row is being renamed or confirming a deletion. */
      readonly status: "idle"
    }
  | {
      /** One row presents its inline rename editor. */
      readonly status: "renaming"
      /** Conversation being renamed. */
      readonly conversationId: string
      /** Draft title entered so far. */
      readonly draftTitle: string
    }
  | {
      /** One row presents its delete confirmation. */
      readonly status: "confirming-delete"
      /** Conversation whose deletion is being confirmed. */
      readonly conversationId: string
    }

/** Properties accepted by {@link ConversationHistoryList}. */
export type ConversationHistoryListProps = {
  /** Non-empty day ranges in presentation order. */
  readonly groups: readonly ConversationHistoryGroup[]
  /** Instant the current list result began, as epoch milliseconds. */
  readonly listedAt: number
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
}

/**
 * Selects the presentation mode of one row.
 *
 * @param rowInteraction - The single row-level interaction being presented.
 * @param conversationId - Conversation the row presents.
 * @returns The row's mode, which is default unless the row owns the
 * interaction.
 */
function calculateConversationRowMode(
  rowInteraction: ConversationRowInteraction,
  conversationId: string
): ConversationHistoryRowMode {
  if (rowInteraction.status === "idle") return { status: "default" }
  if (rowInteraction.conversationId !== conversationId) {
    return { status: "default" }
  }
  if (rowInteraction.status === "renaming") {
    return { status: "renaming", draftTitle: rowInteraction.draftTitle }
  }

  return { status: "confirming-delete" }
}

/**
 * Selects whether one row may currently start a conversation action.
 *
 * @param operation - Conversation operation currently running, if any.
 * @param conversationId - Conversation the row presents.
 * @returns Busy for the operation's own conversation, unavailable for every
 * other conversation while one runs, and available otherwise.
 */
function calculateConversationRowActivity(
  operation: ConversationHistoryOperationState,
  conversationId: string
): ConversationHistoryRowActivity {
  switch (operation.status) {
    case "idle":
    case "failed":
      return { status: "available" }
    case "renaming":
    case "deleting":
    case "opening":
      return operation.conversationId === conversationId
        ? { status: "busy", operation: operation.status }
        : { status: "unavailable" }
  }
}

/**
 * Presents stored conversations grouped by the day they were last updated.
 *
 * @remarks Primary category: presentational. The panel owns the loaded
 * conversations, the single row-level interaction, the running operation, and
 * every domain action. This component owns only collection projection: it
 * preserves the supplied order, keys rows by conversation identity, and marks
 * the conversation open in the chat view. An empty collection is an intentional
 * successful state whose wording distinguishes an empty history from a search
 * that matched nothing; pending and failed states belong to the panel.
 * @param props - Grouped conversations, reference instant, search text, active
 * conversation, row interaction, running operation, and panel-owned actions.
 * @returns The grouped conversation list or its intentional empty state.
 */
export function ConversationHistoryList({
  groups,
  listedAt,
  searchQuery,
  activeConversationId,
  rowInteraction,
  operation,
  actions
}: ConversationHistoryListProps): ReactElement {
  if (groups.length === 0) {
    return (
      <p className="conversation-history__empty">
        {searchQuery.trim() === ""
          ? "Nothing kept. The next thing you send starts a conversation."
          : "Nothing matches that."}
      </p>
    )
  }

  return (
    <div className="conversation-history__groups">
      {groups.map((group) => (
        <section className="conversation-history__group" key={group.label}>
          <h2 className="conversation-history__group-heading">{group.label}</h2>
          <ul className="conversation-history__rows">
            {group.conversations.map((conversation) => (
              <ConversationHistoryRow
                actions={actions}
                activity={calculateConversationRowActivity(
                  operation,
                  conversation.id
                )}
                conversation={conversation}
                isActiveConversation={conversation.id === activeConversationId}
                key={conversation.id}
                listedAt={listedAt}
                mode={calculateConversationRowMode(
                  rowInteraction,
                  conversation.id
                )}
                searchQuery={searchQuery}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
