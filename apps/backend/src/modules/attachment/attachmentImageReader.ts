import type { FindAttachmentImage } from "../agent/agentContext"
import type AttachmentFileStore from "./attachmentFileStore"

/**
 * Builds the reader of one conversation's stored images for the context an
 * agent sends to its model.
 *
 * @param conversationId - UUIDv7 of the conversation whose images are read.
 * @param attachmentFiles - Reads stored attachment files; borrowed for as
 * long as the reader is used.
 * @returns A reader that finds each image's file under the conversation, the
 * message it was sent with, and its name, and answers as the file store does:
 * the bytes, or undefined for a missing file.
 */
export function buildAttachmentImageReader(
  conversationId: string,
  attachmentFiles: Pick<AttachmentFileStore, "readAttachment">
): FindAttachmentImage {
  return (messageId, attachment) =>
    attachmentFiles.readAttachment({
      conversationId,
      messageId,
      name: attachment.name
    })
}
