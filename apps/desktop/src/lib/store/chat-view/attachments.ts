import {
  attachmentNameSchema,
  buildAttachmentDraft,
  buildAttachmentNameKey,
  parseAttachmentContent,
  calculateImageTokens,
  MAXIMUM_ATTACHMENT_BYTES,
  MAXIMUM_MESSAGE_ATTACHMENT_BYTES,
  MAXIMUM_MESSAGE_ATTACHMENT_COUNT,
  type AttachmentContent,
  type ConversationAttachmentDraft
} from "@lys/share"

import type { AttachmentModelSupport } from "@/lib/models/attachment-model-support"

/**
 * Staging rules of the composer's attachment tray.
 *
 * @remarks A staged file is held with its content until the message it is
 * attached to starts its turn; the chat request carries the content as
 * base64. A selection is admitted in two steps: by name and size before any
 * file is read, then by content and by what the loaded model can take once
 * the admitted files are read. Each file is admitted on its own, so a refused
 * file does not keep the others of its selection out, and every refusal is
 * one sentence the composer shows. Each step reports the first refusal it
 * made, in selection order; the store that runs both steps reports the first
 * step's refusal over the second's, and a file that cannot be read keeps the
 * whole selection out of the tray.
 */

/** One file staged for the next message. */
export type StagedAttachment = Readonly<{
  /**
   * Identity within the tray, assigned when the file was staged; it is not
   * the number the conversation gives the attachment.
   */
  id: string
  /**
   * The attachment as the backend stores it: its name and size, and for an
   * image its media type and sides, read from the file's bytes.
   */
  draft: ConversationAttachmentDraft
  /** Base64 of the file's bytes, as the chat request carries them. */
  content: string
}>

/** A file read whole, with its content classified, before it is staged. */
export type AttachmentCandidate = Readonly<{
  /** File name, which becomes the attachment's name. */
  name: string
  /** Size of the file in bytes. */
  sizeBytes: number
  /** What the bytes hold: an image with its sides, text, or neither. */
  content: AttachmentContent
  /** Base64 of the bytes. */
  encoded: string
}>

/** Outcome of admitting a selection by name and size. */
export type AttachmentAdmission = Readonly<{
  /** Files the name and size rules admit, in selection order. */
  admitted: readonly File[]
  /** First refusal of the selection, or undefined when every file was admitted. */
  refusal: string | undefined
}>

/** Outcome of staging the read files. */
export type AttachmentStaging = Readonly<{
  /** The tray with the staged files appended, or the same tray when none was. */
  attachments: readonly StagedAttachment[]
  /** First refusal of the files, or undefined when every file was staged. */
  refusal: string | undefined
}>

/** Tray that holds no file; the same frozen array wherever it is empty. */
export const NO_STAGED_ATTACHMENTS: readonly StagedAttachment[] = Object.freeze(
  []
)

/** Bytes in one mebibyte, for the sentences that name a size limit. */
const BYTES_PER_MEBIBYTE = 1024 * 1024

/** Bytes encoded per call of the base64 encoder, within the argument limit of a call. */
const BASE64_CHUNK_BYTES = 0x8000

/** Refusal of an image while the loaded model has no vision. */
const IMAGE_NEEDS_VISION_REFUSAL = "Images need a model with vision"

/** Refusal of a text file while the loaded model was not trained for tool use. */
const FILE_NEEDS_TOOL_USE_REFUSAL = "Files need a model trained for tool use"

/** What the tray holds, as the name and size rules see it. */
type TrayAccount = {
  /** Canonical names of the files held, so a duplicate is found ignoring case. */
  readonly names: Set<string>
  /** Files held. */
  count: number
  /** Bytes held together. */
  totalBytes: number
}

/** What parsing one candidate found: its staged form or why it was refused. */
type AttachmentCandidateParse =
  | Readonly<{
      /** The candidate, staged. */
      attachment: StagedAttachment
    }>
  | Readonly<{
      /** Why the candidate was refused. */
      refusal: string
    }>

/**
 * Formats a byte limit as the sentences name it.
 *
 * @param bytes - A limit in whole mebibytes.
 * @returns The limit in megabytes, as the person reads it.
 */
function formatMegabytes(bytes: number): string {
  return `${bytes / BYTES_PER_MEBIBYTE} MB`
}

/**
 * Builds the base64 text of bytes.
 *
 * @param bytes - Any bytes.
 * @returns Their base64 text.
 * @remarks The bytes are turned into a binary string in chunks, because the
 * conversion takes them as arguments and a call accepts only so many.
 */
function buildBase64Text(bytes: Uint8Array): string {
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    binary += String.fromCodePoint(
      ...bytes.subarray(offset, offset + BASE64_CHUNK_BYTES)
    )
  }
  return btoa(binary)
}

/**
 * Reads a file whole and classifies its content.
 *
 * @param file - A file the name and size rules admitted.
 * @returns The candidate: the file's name, size, content, and base64.
 * @throws If the file cannot be read, with the file's name in the message and
 * the browser's failure as the cause.
 */
export async function readAttachmentCandidate(
  file: File
): Promise<AttachmentCandidate> {
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await file.arrayBuffer())
  } catch (cause) {
    throw new Error(`The file ${file.name} could not be read`, { cause })
  }

  return {
    name: file.name,
    sizeBytes: bytes.length,
    content: parseAttachmentContent(bytes),
    encoded: buildBase64Text(bytes)
  }
}

/**
 * Finds why the name and size rules refuse a file.
 *
 * @param file - File of the selection.
 * @param tray - What the tray holds before this file.
 * @returns The refusal: a name the backend cannot store, a name already in
 * the tray ignoring case, a full tray, a file over the per-file limit, or a
 * tray that would exceed the per-message limit; undefined when the file is
 * admitted.
 */
function findFileRefusal(file: File, tray: TrayAccount): string | undefined {
  if (!attachmentNameSchema.safeParse(file.name).success) {
    return `The file ${file.name} has a name Lys cannot store`
  }
  if (tray.names.has(buildAttachmentNameKey(file.name))) {
    return `The file ${file.name} is already uploaded`
  }
  if (tray.count >= MAXIMUM_MESSAGE_ATTACHMENT_COUNT) {
    return `A message can carry at most ${MAXIMUM_MESSAGE_ATTACHMENT_COUNT} files`
  }
  if (file.size > MAXIMUM_ATTACHMENT_BYTES) {
    return `The file ${file.name} is larger than ${formatMegabytes(MAXIMUM_ATTACHMENT_BYTES)}`
  }
  if (tray.totalBytes + file.size > MAXIMUM_MESSAGE_ATTACHMENT_BYTES) {
    return `A message's files can total at most ${formatMegabytes(MAXIMUM_MESSAGE_ATTACHMENT_BYTES)}`
  }
  return undefined
}

/**
 * Parses a selection by the name and size rules, before any file is read.
 *
 * @param staged - Files the tray holds.
 * @param files - Files chosen or dropped by the person, in selection order.
 * @returns The admitted files in selection order, each counted against the
 * tray and the files admitted before it, and the first refusal.
 */
export function parseAttachmentSelection(
  staged: readonly StagedAttachment[],
  files: readonly File[]
): AttachmentAdmission {
  const tray: TrayAccount = {
    names: new Set(
      staged.map((attachment) => buildAttachmentNameKey(attachment.draft.name))
    ),
    count: staged.length,
    totalBytes: staged.reduce(
      (total, attachment) => total + attachment.draft.sizeBytes,
      0
    )
  }
  const admitted: File[] = []
  const refusals: string[] = []
  for (const file of files) {
    const refusal = findFileRefusal(file, tray)
    if (refusal !== undefined) {
      refusals.push(refusal)
      continue
    }
    tray.names.add(buildAttachmentNameKey(file.name))
    tray.count += 1
    tray.totalBytes += file.size
    admitted.push(file)
  }
  return { admitted, refusal: refusals[0] }
}

/**
 * Parses one read file by its content and by what the loaded model can take.
 *
 * @param candidate - A read file.
 * @param support - What the loaded model can take.
 * @returns The staged attachment, whose draft is the attachment the backend
 * stores for the file; or the refusal: content that is neither text nor an
 * image Lys sends, an image for a model without vision, or a text file for a
 * model not trained for tool use.
 */
function parseAttachmentCandidate(
  candidate: AttachmentCandidate,
  support: AttachmentModelSupport
): AttachmentCandidateParse {
  const { content } = candidate
  if (content.kind === "unsupported") {
    return {
      refusal: `The file ${candidate.name} is not a text file or an image Lys can send`
    }
  }
  const draft = buildAttachmentDraft(
    candidate.name,
    candidate.sizeBytes,
    content
  )
  if (draft.kind === "image" && !support.vision) {
    return { refusal: IMAGE_NEEDS_VISION_REFUSAL }
  }
  if (draft.kind === "text" && !support.trainedForToolUse) {
    return { refusal: FILE_NEEDS_TOOL_USE_REFUSAL }
  }
  return {
    attachment: {
      id: `attachment-${crypto.randomUUID()}`,
      draft,
      content: candidate.encoded
    }
  }
}

/**
 * Adds to the tray the read files the content rules and the loaded model
 * admit.
 *
 * @param staged - Files the tray holds.
 * @param candidates - Read files, in selection order.
 * @param support - What the loaded model can take.
 * @returns The tray with the admitted files appended in order, or the same
 * tray when none was admitted, and the first refusal.
 */
export function addAttachmentCandidates(
  staged: readonly StagedAttachment[],
  candidates: readonly AttachmentCandidate[],
  support: AttachmentModelSupport
): AttachmentStaging {
  const admitted: StagedAttachment[] = []
  const refusals: string[] = []
  for (const candidate of candidates) {
    const judgement = parseAttachmentCandidate(candidate, support)
    if ("refusal" in judgement) refusals.push(judgement.refusal)
    else admitted.push(judgement.attachment)
  }
  return {
    attachments: admitted.length === 0 ? staged : [...staged, ...admitted],
    refusal: refusals[0]
  }
}

/**
 * Calculates the tokens the staged images are estimated to take in the
 * model's context.
 *
 * @param attachments - Files the tray holds.
 * @returns The sum of each image's estimate, as `calculateImageTokens` makes
 * it; a text file counts nothing, because the model reads it on request.
 */
export function calculateStagedImageTokens(
  attachments: readonly StagedAttachment[]
): number {
  return attachments.reduce(
    (total, { draft }) =>
      draft.kind === "image"
        ? total + calculateImageTokens(draft.width, draft.height)
        : total,
    0
  )
}
