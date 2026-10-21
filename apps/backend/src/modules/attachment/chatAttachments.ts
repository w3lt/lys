import {
  buildAttachmentDraft,
  parseAttachmentContent,
  type ConversationAttachmentDraft
} from "@lys/share"
import type { ChatAttachment } from "@lys/protocol"

/** One attachment of a chat request, decoded and classified. */
export type ParsedChatAttachment = Readonly<{
  /** Validated attachment name. */
  name: string
  /** The attachment's bytes. */
  content: Uint8Array
  /** What the attachment is, read from its bytes, before it is numbered. */
  draft: ConversationAttachmentDraft
}>

/** Outcome of decoding and classifying a request's attachments. */
export type ChatAttachmentsParse =
  | Readonly<{
      /** Every attachment is text or an image Lys sends. */
      status: "parsed"
      /** The attachments in request order; empty when the request has none. */
      attachments: readonly ParsedChatAttachment[]
    }>
  | Readonly<{
      /** An attachment's content is neither text nor an image Lys sends. */
      status: "unsupported"
      /** Name of the first such attachment. */
      fileName: string
    }>

/** Attachments of a request that carries none. */
const NO_ATTACHMENTS: ChatAttachmentsParse = Object.freeze({
  status: "parsed",
  attachments: Object.freeze([])
})

/**
 * Builds what one attachment is from its name and classified content.
 *
 * @param attachment - Validated request attachment.
 * @param content - Its decoded bytes.
 * @returns The decoded attachment with its draft, or undefined when the
 * content is unsupported.
 */
function buildParsedAttachment(
  attachment: ChatAttachment,
  content: Uint8Array
): ParsedChatAttachment | undefined {
  const classified = parseAttachmentContent(content)
  if (classified.kind === "unsupported") return undefined
  return Object.freeze({
    name: attachment.name,
    content,
    draft: buildAttachmentDraft(attachment.name, content.length, classified)
  })
}

/**
 * Decodes the attachments of a chat request and reads what each one is from
 * its bytes.
 *
 * @param attachments - Validated attachments of the request; undefined when
 * it carries none.
 * @returns Every attachment decoded with its draft, in request order; or the
 * name of the first attachment whose content Lys cannot send, which stops
 * the parse.
 */
export function parseChatAttachments(
  attachments: readonly ChatAttachment[] | undefined
): ChatAttachmentsParse {
  if (attachments === undefined) return NO_ATTACHMENTS
  const parsed: ParsedChatAttachment[] = []
  for (const attachment of attachments) {
    const parsedAttachment = buildParsedAttachment(
      attachment,
      Buffer.from(attachment.content, "base64")
    )
    if (parsedAttachment === undefined)
      return Object.freeze({ status: "unsupported", fileName: attachment.name })
    parsed.push(parsedAttachment)
  }
  return Object.freeze({ status: "parsed", attachments: Object.freeze(parsed) })
}
