import { calculateImageTokens } from "@lys/share"
import { X } from "lucide-react"

import type { StagedAttachment } from "@/lib/store/chat-view/attachments"

import { formatAttachmentKind } from "./composer-attachments"
import { formatTokenCount } from "./composer-context"

/** Properties accepted by {@link ComposerAttachmentTray}. */
export type ComposerAttachmentTrayProps = {
  /** Files staged for the next message, in staging order. */
  readonly attachments: readonly StagedAttachment[]
  /** Invoked with the attachment the user removed from the tray. */
  readonly onRemove: (attachmentId: string) => void
}

/**
 * Lists the files staged for the next message.
 *
 * @remarks The parent owns the staged files and removal; this component owns
 * no state, effects, or resources. An image shows the tokens it is estimated
 * to take, labelled with `~` for that reason, because the model sees it with
 * the message; a text file shows no count, because the model reads it on
 * request. Rendering an empty tray is the parent's decision; given an empty
 * list this component renders an empty list element.
 *
 * @param props - Staged files and the removal callback.
 * @returns The composer's attachment tray.
 */
export default function ComposerAttachmentTray({
  attachments,
  onRemove
}: ComposerAttachmentTrayProps) {
  return (
    <ul aria-label="Attached to this message" className="composer__tray">
      {attachments.map(({ id, draft }) => (
        <li className="composer__chip" key={id}>
          <span className="composer__chip-kind">
            {formatAttachmentKind(draft)}
          </span>
          <span className="composer__chip-name">{draft.name}</span>
          {draft.kind === "image" ? (
            <span className="composer__chip-tokens">
              ~
              {formatTokenCount(
                calculateImageTokens(draft.width, draft.height)
              )}
            </span>
          ) : null}
          <button
            aria-label={`Remove ${draft.name} from context`}
            className="composer__chip-remove"
            onClick={() => onRemove(id)}
            type="button"
          >
            <X aria-hidden="true" />
          </button>
        </li>
      ))}
    </ul>
  )
}
