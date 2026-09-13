import { X } from "lucide-react"

import { type ComposerAttachment, formatTokenCount } from "./composer-context"

/** Properties accepted by {@link ComposerAttachmentTray}. */
export type ComposerAttachmentTrayProps = {
  /** Files staged for the next message, in staging order. */
  readonly attachments: readonly ComposerAttachment[]
  /**
   * Identifier of the attachment singled out as the cause of an overflowing
   * window, or `undefined` while the request still fits.
   */
  readonly overflowingAttachmentId?: string
  /** Invoked with the attachment the user removed from the tray. */
  readonly onRemove: (attachmentId: string) => void
}

/**
 * Lists the files staged for the next message with their estimated cost.
 *
 * @remarks The parent owns the staged files,
 * which attachment is blamed for an overflowing window, and removal; this
 * component owns no state, effects, or resources. Token counts are estimates
 * and are labelled with `~` for that reason. The blamed chip is marked by both
 * a tone change and its removal button's accessible name, so the warning does
 * not rest on color alone. Rendering an empty tray is the parent's decision;
 * given an empty list this component renders an empty list element.
 *
 * @param props - Staged files, the overflow attribution, and removal callback.
 * @returns The composer's context tray.
 */
export default function ComposerAttachmentTray({
  attachments,
  overflowingAttachmentId,
  onRemove
}: ComposerAttachmentTrayProps) {
  return (
    <ul aria-label="Attached to this message" className="composer__tray">
      {attachments.map((attachment) => {
        const isOverflowing = attachment.id === overflowingAttachmentId

        return (
          <li
            className="composer__chip"
            data-overflowing={isOverflowing ? "" : undefined}
            key={attachment.id}
          >
            <span className="composer__chip-kind">{attachment.kind}</span>
            <span className="composer__chip-name">{attachment.name}</span>
            <span className="composer__chip-tokens">
              ~{formatTokenCount(attachment.estimatedTokens)}
            </span>
            <button
              aria-label={
                isOverflowing
                  ? `Remove ${attachment.name} from context; it does not fit the window`
                  : `Remove ${attachment.name} from context`
              }
              className="composer__chip-remove"
              onClick={() => onRemove(attachment.id)}
              type="button"
            >
              <X aria-hidden="true" />
            </button>
          </li>
        )
      })}
    </ul>
  )
}
