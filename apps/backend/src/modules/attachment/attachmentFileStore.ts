import { attachmentNameSchema } from "@lys/share"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, relative, resolve, isAbsolute } from "node:path"
import * as z from "zod"

/** One file to store with a message. */
export type AttachmentFile = Readonly<{
  /** Validated attachment name, which is the file's name on disk. */
  name: string
  /** The file's bytes. */
  content: Uint8Array
}>

/** Where one stored attachment's file is: its conversation, message, and name. */
export type StoredAttachmentLocation = Readonly<{
  /** UUIDv7 of the conversation. */
  conversationId: string
  /** UUIDv7 of the user message the attachment was sent with. */
  messageId: string
  /** Validated attachment name. */
  name: string
}>

/** Validates an identifier that names one folder of the store. */
const folderIdentitySchema = z.uuidv7()

/**
 * Answers whether a failure says a path does not exist.
 *
 * @param failure - Rejection of a file operation.
 * @returns True for Node's `ENOENT` and `ENOTDIR` codes.
 */
function isMissingPathFailure(failure: unknown): boolean {
  return (
    failure instanceof Error &&
    "code" in failure &&
    (failure.code === "ENOENT" || failure.code === "ENOTDIR")
  )
}

/**
 * Owns the attachments directory, under which every attachment file of every
 * conversation is kept at `<conversation id>/<message id>/<name>`, and
 * saves, reads, and deletes those files for the chat and conversation
 * routes.
 *
 * @remarks Invariant: every path it touches is built only from a validated
 * UUIDv7 and a validated attachment name, and lies under the directory it
 * was created with; a value that breaks the attachment name rules is
 * refused before any file operation. The directory and each conversation's
 * folder are created on the first save into them. A message's folder and
 * each file in it are created exclusively, so a message is never written
 * twice and nothing already on disk is overwritten or removed by a save.
 * Resource ownership: it opens no handle beyond each operation; nothing is
 * released on close. Concurrency model: reentrant; each message's folder is
 * saved once, by one request.
 */
export default class AttachmentFileStore {
  /** Absolute path of the attachments directory. */
  readonly #rootPath: string

  /**
   * Creates the store for one attachments directory without touching the
   * disk.
   *
   * @param attachmentsDirectoryPath - Absolute path of the directory that
   * holds every attachment file.
   */
  public constructor(attachmentsDirectoryPath: string) {
    this.#rootPath = resolve(attachmentsDirectoryPath)
  }

  /**
   * Saves the files of one message into the message's new folder.
   *
   * @param conversationId - UUIDv7 of the conversation.
   * @param messageId - UUIDv7 of the user message; its folder must not exist
   * yet.
   * @param files - Files in message order, each name once ignoring case.
   * @returns Settlement once every file is written; the files are written
   * together.
   * @throws If an identifier or a name is invalid; if the conversation's
   * folder cannot be created or the message's folder already exists
   * (`EEXIST`), before any file is written; or if a file cannot be created,
   * as when a name repeats: once every write has settled, the message's
   * folder and every file written into it are deleted, and the first
   * failure in message order is thrown, or an `AggregateError` holding it
   * and the deletion's own failure when that fails too. The conversation's
   * folder stays.
   */
  public async saveMessageAttachments(
    conversationId: string,
    messageId: string,
    files: readonly AttachmentFile[]
  ): Promise<void> {
    const folderPath = this.#buildMessageFolderPath(conversationId, messageId)
    const filePaths = files.map((file) => ({
      path: this.#buildAttachmentFilePath({
        conversationId,
        messageId,
        name: file.name
      }),
      content: file.content
    }))
    await mkdir(this.#buildConversationFolderPath(conversationId), {
      recursive: true
    })
    await mkdir(folderPath)
    const outcomes = await Promise.allSettled(
      filePaths.map((file) =>
        writeFile(file.path, file.content, { flag: "wx" })
      )
    )
    const failure = outcomes.find((outcome) => outcome.status === "rejected")
    if (failure === undefined) return
    await deleteFolderAfterFailure(folderPath, failure.reason)
    throw failure.reason
  }

  /**
   * Reads one stored attachment's file.
   *
   * @param location - The attachment's conversation, message, and name.
   * @returns The file's bytes, or undefined when the file is missing.
   * @throws If an identifier or the name is invalid, or the file cannot be
   * read for a reason other than being missing.
   */
  public async readAttachment(
    location: StoredAttachmentLocation
  ): Promise<Uint8Array | undefined> {
    const filePath = this.#buildAttachmentFilePath(location)
    try {
      return await readFile(filePath)
    } catch (error) {
      if (isMissingPathFailure(error)) return undefined
      throw error
    }
  }

  /**
   * Deletes every attachment file of one message with the message's folder.
   *
   * @param conversationId - UUIDv7 of the conversation.
   * @param messageId - UUIDv7 of the user message.
   * @returns Settlement once the folder is gone; a message without a folder
   * changes nothing. The conversation's folder stays.
   * @throws If an identifier is invalid or the folder cannot be removed.
   */
  public async deleteMessageAttachments(
    conversationId: string,
    messageId: string
  ): Promise<void> {
    await rm(this.#buildMessageFolderPath(conversationId, messageId), {
      recursive: true,
      force: true
    })
  }

  /**
   * Deletes every attachment file of one conversation with the conversation's
   * folder.
   *
   * @param conversationId - UUIDv7 of the conversation.
   * @returns Settlement once the folder is gone; a conversation without a
   * folder changes nothing.
   * @throws If the identifier is invalid or the folder cannot be removed.
   */
  public async deleteConversationAttachments(
    conversationId: string
  ): Promise<void> {
    await rm(this.#buildConversationFolderPath(conversationId), {
      recursive: true,
      force: true
    })
  }

  /**
   * Builds the path of one conversation's folder.
   *
   * @param conversationId - Untrusted conversation identifier.
   * @returns The folder's absolute path under the attachments directory.
   * @throws A Zod error when the identifier is not a UUIDv7.
   */
  #buildConversationFolderPath(conversationId: string): string {
    return this.#buildRootedPath(folderIdentitySchema.parse(conversationId))
  }

  /**
   * Builds the path of one message's folder.
   *
   * @param conversationId - Untrusted conversation identifier.
   * @param messageId - Untrusted message identifier.
   * @returns The folder's absolute path under the conversation's folder.
   * @throws A Zod error when an identifier is not a UUIDv7.
   */
  #buildMessageFolderPath(conversationId: string, messageId: string): string {
    return this.#buildRootedPath(
      folderIdentitySchema.parse(conversationId),
      folderIdentitySchema.parse(messageId)
    )
  }

  /**
   * Builds the path of one attachment's file.
   *
   * @param location - Untrusted conversation, message, and name.
   * @returns The file's absolute path under the message's folder.
   * @throws A Zod error when an identifier is not a UUIDv7 or the name
   * breaks the attachment name rules.
   */
  #buildAttachmentFilePath(location: StoredAttachmentLocation): string {
    return this.#buildRootedPath(
      folderIdentitySchema.parse(location.conversationId),
      folderIdentitySchema.parse(location.messageId),
      attachmentNameSchema.parse(location.name)
    )
  }

  /**
   * Builds a path from validated segments under the attachments directory.
   *
   * @param segments - Validated segments, each one entry of its folder.
   * @returns The absolute path.
   * @throws If the joined path leaves the attachments directory, which the
   * validated segments cannot cause; the check stands in case a rule changes.
   */
  #buildRootedPath(...segments: readonly string[]): string {
    const path = join(this.#rootPath, ...segments)
    const relativePath = relative(this.#rootPath, path)
    if (
      relativePath === "" ||
      relativePath.startsWith("..") ||
      isAbsolute(relativePath)
    )
      throw new Error("Attachment path leaves the attachments directory")
    return path
  }
}

/**
 * Deletes a message's folder after a write into it failed.
 *
 * @param folderPath - The message's folder.
 * @param writeFailure - Failure of the write.
 * @returns Settlement once the folder is gone.
 * @throws An `AggregateError` holding the write failure and the deletion's
 * failure when the folder cannot be removed.
 */
async function deleteFolderAfterFailure(
  folderPath: string,
  writeFailure: unknown
): Promise<void> {
  try {
    await rm(folderPath, { recursive: true, force: true })
  } catch (error) {
    throw new AggregateError(
      [writeFailure, error],
      "Attachment files could not be deleted after a failed write",
      { cause: error }
    )
  }
}
