import type { ConversationAttachmentDraft } from "@lys/share"

/**
 * Presentation of an attachment chip, in the composer's tray and in the
 * transcript.
 *
 * @remarks The chat-view store owns the staged files and their admission;
 * this module only formats what a chip shows.
 */

/** Longest extension shown as a chip's kind marker. */
const MAXIMUM_KIND_LENGTH = 4

/** Kind marker of a text file whose name carries no usable extension. */
const DEFAULT_TEXT_KIND = "txt"

/**
 * Formats the kind marker of an attachment chip.
 *
 * @param attachment - Staged or stored attachment.
 * @returns For an image, the subtype of the media type read from its bytes,
 * such as `png`; for a text file, the lowercase extension of its name without
 * the dot, truncated for display, or `txt` when the name carries none.
 */
export function formatAttachmentKind(
  attachment: ConversationAttachmentDraft
): string {
  if (attachment.kind === "image") {
    return attachment.mediaType.slice(attachment.mediaType.indexOf("/") + 1)
  }

  const separatorIndex = attachment.name.lastIndexOf(".")
  if (separatorIndex <= 0) return DEFAULT_TEXT_KIND

  const extension = attachment.name.slice(separatorIndex + 1).toLowerCase()

  return extension.slice(0, MAXIMUM_KIND_LENGTH) || DEFAULT_TEXT_KIND
}
