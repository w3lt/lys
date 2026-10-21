import type {
  ConversationAttachment,
  ConversationImageAttachment
} from "@lys/share"

/**
 * Formats the label the model knows an attachment by.
 *
 * @param attachment - Stored attachment.
 * @returns Its number in the form the attachment list and the reader use,
 * followed by its name, such as `[attachment 3] notes.md`.
 */
export function formatAttachmentLabel(
  attachment: Pick<ConversationAttachment, "number" | "name">
): string {
  return `[attachment ${attachment.number}] ${attachment.name}`
}

/**
 * Formats a byte count for the model.
 *
 * @param byteCount - Whole number of bytes.
 * @returns The count with comma thousands separators and the unit, such as
 * `12,345 bytes`.
 */
export function formatByteCount(byteCount: number): string {
  return `${byteCount.toLocaleString("en-US")} bytes`
}

/**
 * Formats what one attachment is, for the attachment list.
 *
 * @param attachment - Stored attachment.
 * @returns Its label, then its media type and sides for an image or `text`
 * for a text file, and its size.
 */
function formatAttachmentEntry(attachment: ConversationAttachment): string {
  const description =
    attachment.kind === "image"
      ? `${attachment.mediaType}, ${attachment.width}×${attachment.height}`
      : "text"
  return `${formatAttachmentLabel(attachment)} (${description}, ${formatByteCount(attachment.sizeBytes)})`
}

/**
 * Formats the placeholder that stands for an image the model does not get.
 *
 * @param attachment - Stored image attachment.
 * @param reason - Why the image is not sent, as a clause after the label.
 * @returns One sentence naming the image and the reason.
 */
function formatImagePlaceholder(
  attachment: ConversationImageAttachment,
  reason: string
): string {
  return `${formatAttachmentLabel(attachment)} is an image ${reason}`
}

/**
 * Formats the placeholder for an image whose file is missing from this
 * machine.
 *
 * @param attachment - Stored image attachment.
 * @returns One sentence the model reads instead of the image.
 */
export function formatMissingImagePlaceholder(
  attachment: ConversationImageAttachment
): string {
  return formatImagePlaceholder(
    attachment,
    "whose file is missing from this machine, so it cannot be shown."
  )
}

/**
 * Formats the placeholder for an image a model without vision cannot see.
 *
 * @param attachment - Stored image attachment.
 * @returns One sentence the model reads instead of the image.
 */
export function formatUnseenImagePlaceholder(
  attachment: ConversationImageAttachment
): string {
  return formatImagePlaceholder(attachment, "that this model cannot see.")
}

/**
 * Builds the text of a user message as the model reads it: the person's
 * text, then the message's attachments, then the placeholders for images it
 * does not get.
 *
 * @param content - The person's text.
 * @param attachments - The message's stored attachments in number order.
 * @param placeholders - Sentences standing for images the model does not
 * get, in attachment order; empty when it gets every image.
 * @returns The text alone for a message without attachments; otherwise the
 * text, a blank line, `Attached files:` with one line per attachment giving
 * its label, kind, and size, and one line per placeholder.
 */
export function buildUserMessageText(
  content: string,
  attachments: readonly ConversationAttachment[],
  placeholders: readonly string[]
): string {
  if (attachments.length === 0) return content
  return [
    content,
    "",
    "Attached files:",
    ...attachments.map(formatAttachmentEntry),
    ...placeholders
  ].join("\n")
}
