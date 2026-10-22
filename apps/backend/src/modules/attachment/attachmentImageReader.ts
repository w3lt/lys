import type {
  FindAttachmentImage,
  GetAttachmentImageFileStatus
} from "../agent/agentContext"
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

/**
 * Builds the lookup of whether one conversation's stored images have their
 * files, for measuring the context an agent sends without reading them.
 *
 * @param conversationId - UUIDv7 of the conversation whose images are looked
 * up.
 * @param attachmentFiles - Examines stored attachment files; borrowed for as
 * long as the lookup is used.
 * @returns A lookup that finds each image's file under the conversation, the
 * message it was sent with, and its name, and answers as the file store does:
 * `stored` or `missing`.
 */
export function buildAttachmentImageFileStatusLookup(
  conversationId: string,
  attachmentFiles: Pick<AttachmentFileStore, "getAttachmentFileStatus">
): GetAttachmentImageFileStatus {
  return (messageId, attachment) =>
    attachmentFiles.getAttachmentFileStatus({
      conversationId,
      messageId,
      name: attachment.name
    })
}
