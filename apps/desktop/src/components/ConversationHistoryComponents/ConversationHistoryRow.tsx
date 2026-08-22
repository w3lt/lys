import type { ConversationSummary } from "@lys/protocol"
import { Pencil, X } from "lucide-react"
import type { ReactElement } from "react"

import { Button } from "@/components/ui/button"

import {
  createConversationExcerptHighlight,
  formatConversationExcerpt,
  formatConversationTitle,
  formatConversationUpdatedTime
} from "./conversation-history-presentation"
import { ConversationRenameField } from "./ConversationRenameField"

/** Presentation mode of one conversation history row. */
export type ConversationHistoryRowMode =
  | {
      /** The row presents the conversation and its actions. */
      readonly status: "default"
    }
  | {
      /** The row presents the inline rename editor. */
      readonly status: "renaming"
      /** Draft title owned by the panel while the editor is presented. */
      readonly draftTitle: string
    }
  | {
      /** The row presents the delete confirmation. */
      readonly status: "confirming-delete"
    }

/** Availability of the conversation actions offered by one row. */
export type ConversationHistoryRowActivity =
  | {
      /** Every action this row offers can be started. */
      readonly status: "available"
    }
  | {
      /** Another conversation is busy, so this row offers no action. */
      readonly status: "unavailable"
    }
  | {
      /** An operation on this conversation is running. */
      readonly status: "busy"
      /** Operation currently running on this conversation. */
      readonly operation: "renaming" | "deleting" | "opening"
    }

/**
 * The complete set of actions the history panel owns for one row.
 *
 * @remarks Every member is required: each control a row renders is enabled, so
 * none of these actions may be absent. The panel owns the row interaction and
 * the domain operations; a row only reports the reader's intent.
 */
export type ConversationRowActions = {
  /** Requests that the panel open one conversation in the chat view. */
  readonly onOpenConversation: (conversationId: string) => void
  /** Requests that the panel present one row's rename editor. */
  readonly onStartConversationRename: (conversationId: string) => void
  /** Receives a proposed replacement for the panel-owned draft title. */
  readonly onRenameDraftTitleChange: (draftTitle: string) => void
  /** Requests that the panel persist one row's draft title. */
  readonly onSubmitConversationRename: (conversationId: string) => void
  /** Requests that the panel present one row's delete confirmation. */
  readonly onRequestConversationDelete: (conversationId: string) => void
  /** Requests that the panel permanently delete one conversation. */
  readonly onDeleteConversation: (conversationId: string) => void
  /** Requests that the panel return every row to its default presentation. */
  readonly onCancelConversationAction: () => void
}

/** Properties accepted by {@link ConversationHistoryRow}. */
export type ConversationHistoryRowProps = {
  /** Conversation this row presents. */
  readonly conversation: ConversationSummary
  /** Instant the current list result began, as epoch milliseconds. */
  readonly listedAt: number
  /** Current search text, used to mark the matched part of the excerpt. */
  readonly searchQuery: string
  /** Whether this conversation is the one open in the chat view. */
  readonly isActiveConversation: boolean
  /** Which of the row's mutually exclusive presentations is shown. */
  readonly mode: ConversationHistoryRowMode
  /** Whether and why the row's actions are currently unavailable. */
  readonly activity: ConversationHistoryRowActivity
  /** Panel-owned actions this row reports the reader's intent to. */
  readonly actions: ConversationRowActions
}

/** Operation currently running on the conversation one row presents. */
type ConversationRowOperation = Extract<
  ConversationHistoryRowActivity,
  { status: "busy" }
>["operation"]

/** Status wording shown while an operation runs on one conversation. */
const BUSY_STATUS_TEXT: Readonly<Record<ConversationRowOperation, string>> =
  Object.freeze({
    renaming: "Saving…",
    deleting: "Deleting…",
    opening: "Opening…"
  })

/**
 * Presents one stored conversation and the actions it offers.
 *
 * @remarks Primary category: interactive feature. The panel owns the row's
 * mode, its draft title, action availability, and every domain action; this
 * component keeps no copy of them and reaches no application store. The row is
 * a list item containing sibling controls rather than one enclosing control,
 * so opening, renaming, and deleting stay independently operable by pointer
 * and keyboard. Rename and delete controls are revealed on hover and on focus
 * and stay in the focus order at all times. The delete confirmation replaces
 * the row's metadata so the destructive choice is explicit rather than
 * immediate, and every control is disabled while any conversation operation is
 * running.
 * @param props - Conversation, reference instant, search text, active state,
 * row mode, action availability, and the panel-owned actions.
 * @returns The rendered conversation history row.
 */
export function ConversationHistoryRow({
  conversation,
  listedAt,
  searchQuery,
  isActiveConversation,
  mode,
  activity,
  actions
}: ConversationHistoryRowProps): ReactElement {
  const title = formatConversationTitle(conversation.title)
  const highlight = createConversationExcerptHighlight(
    formatConversationExcerpt(conversation.excerpt),
    searchQuery
  )
  const isActionDisabled = activity.status !== "available"
  const rowClassName = isActiveConversation
    ? "conversation-history__row conversation-history__row--active"
    : "conversation-history__row"

  if (mode.status === "renaming") {
    return (
      <li className={rowClassName}>
        <ConversationRenameField
          conversationTitle={title}
          draftTitle={mode.draftTitle}
          isSubmitting={activity.status === "busy"}
          onCancelConversationRename={actions.onCancelConversationAction}
          onDraftTitleChange={actions.onRenameDraftTitleChange}
          onSubmitConversationRename={() =>
            actions.onSubmitConversationRename(conversation.id)
          }
        />
      </li>
    )
  }

  return (
    <li className={rowClassName}>
      <button
        className="conversation-history__open"
        disabled={isActionDisabled}
        onClick={() => actions.onOpenConversation(conversation.id)}
        type="button"
      >
        <span className="conversation-history__title">{title}</span>
        {isActiveConversation && (
          <span className="conversation-history__badge">Open</span>
        )}
        <span className="conversation-history__excerpt">
          {highlight.before}
          <mark className="conversation-history__excerpt-match">
            {highlight.match}
          </mark>
          {highlight.after}
        </span>
      </button>

      {mode.status === "confirming-delete" ? (
        <div className="conversation-history__confirm">
          <span className="conversation-history__confirm-question">
            Delete for good?
          </span>
          <Button
            aria-label={`Keep ${title}`}
            disabled={isActionDisabled}
            onClick={actions.onCancelConversationAction}
            size="sm"
            type="button"
            variant="outline"
          >
            Keep
          </Button>
          <Button
            aria-label={`Delete ${title} for good`}
            disabled={isActionDisabled}
            onClick={() => actions.onDeleteConversation(conversation.id)}
            size="sm"
            type="button"
            variant="destructive"
          >
            Delete
          </Button>
        </div>
      ) : (
        <div className="conversation-history__meta">
          {activity.status === "busy" ? (
            <span className="conversation-history__row-status" role="status">
              {BUSY_STATUS_TEXT[activity.operation]}
            </span>
          ) : (
            <span className="conversation-history__time">
              {formatConversationUpdatedTime(conversation.updatedAt, listedAt)}
            </span>
          )}
          <div className="conversation-history__actions">
            <Button
              aria-label={`Rename ${title}`}
              disabled={isActionDisabled}
              onClick={() => actions.onStartConversationRename(conversation.id)}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <Pencil aria-hidden="true" />
            </Button>
            <Button
              aria-label={`Delete ${title}`}
              disabled={isActionDisabled}
              onClick={() =>
                actions.onRequestConversationDelete(conversation.id)
              }
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <X aria-hidden="true" />
            </Button>
          </div>
        </div>
      )}
    </li>
  )
}
