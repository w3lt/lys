import { X } from "lucide-react"

import { type ComposerAttachment, formatTokenCount } from "./composer-context"

/** Properties accepted by {@link ComposerAttachmentTray}. */
export type ComposerAttachmentTrayProps = {
  /** Files staged for the next message, in staging order. */
  readonly attachments: readonly ComposerAttachment[]
  /** Invoked with the attachment the user removed from the tray. */
  readonly onRemove: (attachmentId: string) => void
}

/**
 * Lists the files staged for the next message with their estimated cost.
 *
 * @remarks The parent owns the staged files and removal; this component owns
 * no state, effects, or resources. Token counts are estimates and are
 * labelled with `~` for that reason. Rendering an empty tray is the parent's
 * decision; given an empty list this component renders an empty list
 * element.
 *
 * @param props - Staged files and the removal callback.
 * @returns The composer's context tray.
 */
export default function ComposerAttachmentTray({
  attachments,
  onRemove
}: ComposerAttachmentTrayProps) {
  return (
    <ul aria-label="Attached to this message" className="composer__tray">
      {attachments.map((attachment) => (
        <li className="composer__chip" key={attachment.id}>
          <span className="composer__chip-kind">{attachment.kind}</span>
          <span className="composer__chip-name">{attachment.name}</span>
          <span className="composer__chip-tokens">
            ~{formatTokenCount(attachment.estimatedTokens)}
          </span>
          <button
            aria-label={`Remove ${attachment.name} from context`}
            className="composer__chip-remove"
            onClick={() => onRemove(attachment.id)}
            type="button"
          >
            <X aria-hidden="true" />
          </button>
        </li>
      ))}
    </ul>
  )
}
