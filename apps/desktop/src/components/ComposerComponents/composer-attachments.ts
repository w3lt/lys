import {
  type ComposerAttachment,
  estimateAttachmentTokens
} from "./composer-context"

/**
 * Staging rules for the composer's context tray.
 *
 * @remarks Staged files are held in the renderer and are never uploaded or
 * attached to a chat request: the chat protocol has no attachment field. The
 * tray exists so the composer's layout and context accounting are settled
 * ahead of that backend work.
 */

/** Files accepted from one drop, paste, or file-picker selection. */
const MAXIMUM_FILES_PER_SELECTION = 6

/** Files the tray retains; staging past this drops the oldest entries. */
const MAXIMUM_STAGED_FILES = 8

/** Shortest pasted text promoted from message body to an attachment. */
export const PASTED_TEXT_ATTACHMENT_THRESHOLD = 1200

/** Extension used for an attachment created from pasted text. */
const PASTED_TEXT_EXTENSION = "txt"

/** Longest extension retained as a chip's kind marker. */
const MAXIMUM_KIND_LENGTH = 4

/** Fallback kind marker for a file with no usable extension. */
const DEFAULT_ATTACHMENT_KIND = "txt"

/**
 * Reads the chip kind marker from a file name.
 *
 * @param fileName - Name of the staged file.
 * @returns The lowercase extension without its dot, truncated for display, or
 * the default marker when the name carries no extension.
 */
function readAttachmentKind(fileName: string): string {
  const separatorIndex = fileName.lastIndexOf(".")
  if (separatorIndex <= 0) return DEFAULT_ATTACHMENT_KIND

  const extension = fileName.slice(separatorIndex + 1).toLowerCase()

  return extension.slice(0, MAXIMUM_KIND_LENGTH) || DEFAULT_ATTACHMENT_KIND
}

/**
 * Creates one staged attachment with its estimated token cost.
 *
 * @param fileName - Name shown on the chip.
 * @param sizeBytes - File size used to estimate the token cost.
 * @returns The staged attachment.
 * @remarks The identifier is unique only within this tray; it is not a
 * backend-assigned identity and does not survive a reload.
 */
export function createComposerAttachment(
  fileName: string,
  sizeBytes: number
): ComposerAttachment {
  return {
    id: `attachment-${crypto.randomUUID()}`,
    name: fileName,
    kind: readAttachmentKind(fileName),
    estimatedTokens: estimateAttachmentTokens(sizeBytes)
  }
}

/**
 * Stages a selection of files onto the current tray.
 *
 * @param staged - Attachments currently held by the tray.
 * @param files - Files chosen, dropped, or pasted by the user.
 * @returns The new tray contents, oldest entries dropped past the retention
 * limit; the original array is returned unchanged when nothing was selected.
 */
export function stageComposerFiles(
  staged: readonly ComposerAttachment[],
  files: readonly File[]
): readonly ComposerAttachment[] {
  const selected = files
    .slice(0, MAXIMUM_FILES_PER_SELECTION)
    .map((file) => createComposerAttachment(file.name, file.size))
  if (selected.length === 0) return staged

  return [...staged, ...selected].slice(-MAXIMUM_STAGED_FILES)
}

/**
 * Stages a long pasted string as a text attachment.
 *
 * @param staged - Attachments currently held by the tray.
 * @param pastedText - Text taken from the clipboard.
 * @returns The new tray contents, oldest entries dropped past the retention
 * limit.
 * @remarks Callers decide whether the paste is long enough to divert using
 * {@link PASTED_TEXT_ATTACHMENT_THRESHOLD}; this function stages whatever it is
 * given. The generated name numbers pasted entries in staging order.
 */
export function stagePastedText(
  staged: readonly ComposerAttachment[],
  pastedText: string
): readonly ComposerAttachment[] {
  const pastedCount = staged.filter((attachment) =>
    attachment.name.startsWith("pasted-")
  ).length
  const attachment = createComposerAttachment(
    `pasted-${pastedCount + 1}.${PASTED_TEXT_EXTENSION}`,
    pastedText.length
  )

  return [...staged, attachment].slice(-MAXIMUM_STAGED_FILES)
}

/**
 * Removes one attachment from the tray.
 *
 * @param staged - Attachments currently held by the tray.
 * @param attachmentId - Identifier of the attachment to remove.
 * @returns The remaining attachments in their existing order.
 */
export function removeComposerAttachment(
  staged: readonly ComposerAttachment[],
  attachmentId: string
): readonly ComposerAttachment[] {
  return staged.filter((attachment) => attachment.id !== attachmentId)
}
