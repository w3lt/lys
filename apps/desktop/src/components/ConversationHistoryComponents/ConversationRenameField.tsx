import { Check, X } from "lucide-react"
import { useId } from "react"
import type { FormEvent, KeyboardEvent, ReactElement } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

/** Properties accepted by {@link ConversationRenameField}. */
export type ConversationRenameFieldProps = {
  /** Current title of the conversation being renamed. */
  readonly conversationTitle: string
  /** Draft title owned by the parent while the editor is presented. */
  readonly draftTitle: string
  /** Whether the rename is being persisted and the editor is inert. */
  readonly isSubmitting: boolean
  /** Receives a proposed replacement for the parent-owned draft title. */
  readonly onDraftTitleChange: (draftTitle: string) => void
  /** Requests that the parent persist the current draft title. */
  readonly onSubmitConversationRename: () => void
  /** Requests that the parent abandon the rename without persisting it. */
  readonly onCancelConversationRename: () => void
}

/**
 * Presents the inline editor that renames one conversation.
 *
 * @remarks Primary category: interactive feature. The parent owns the draft
 * title, the submission, and the cancellation; this component keeps no copy of
 * them. Submitting through `Enter` or the save control and cancelling through
 * `Escape` or the cancel control produce the same parent-owned transitions, so
 * pointer and keyboard operation stay equivalent. A blank draft leaves the
 * save control disabled rather than silently discarding the rename.
 * @param props - Current title, parent-owned draft, submission state, and the
 * parent-owned change, submit, and cancel actions.
 * @returns The rename form with its save and cancel controls.
 */
export function ConversationRenameField({
  conversationTitle,
  draftTitle,
  isSubmitting,
  onDraftTitleChange,
  onSubmitConversationRename,
  onCancelConversationRename
}: ConversationRenameFieldProps): ReactElement {
  const renameInputId = useId()
  const isDraftTitleBlank = draftTitle.trim() === ""

  /**
   * Persists the draft title instead of performing a native form submission.
   *
   * @param event - Submit event emitted by the rename form.
   */
  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (isDraftTitleBlank || isSubmitting) return

    onSubmitConversationRename()
  }

  /**
   * Abandons the rename when the reader presses `Escape` in the editor.
   *
   * @param event - Keyboard event emitted by the rename input.
   */
  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key !== "Escape") return

    event.preventDefault()
    onCancelConversationRename()
  }

  return (
    <form className="conversation-history__rename" onSubmit={handleSubmit}>
      <label className="sr-only" htmlFor={renameInputId}>
        Rename {conversationTitle}
      </label>
      <Input
        autoComplete="off"
        autoFocus={true}
        className="conversation-history__rename-input"
        disabled={isSubmitting}
        id={renameInputId}
        onChange={(event) => onDraftTitleChange(event.currentTarget.value)}
        onKeyDown={handleKeyDown}
        spellCheck={false}
        value={draftTitle}
      />
      <Button
        aria-label={`Save the new name for ${conversationTitle}`}
        disabled={isDraftTitleBlank || isSubmitting}
        size="icon-sm"
        type="submit"
        variant="outline"
      >
        <Check aria-hidden="true" />
      </Button>
      <Button
        aria-label={`Cancel renaming ${conversationTitle}`}
        disabled={isSubmitting}
        onClick={onCancelConversationRename}
        size="icon-sm"
        type="button"
        variant="ghost"
      >
        <X aria-hidden="true" />
      </Button>
    </form>
  )
}
