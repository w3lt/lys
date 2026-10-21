import {
  toolDefinitionSchema,
  type ConversationAttachment,
  type ConversationMessage,
  type ConversationUserMessage,
  type ToolDefinition
} from "@lys/share"
import type {
  BuiltInTool,
  BuiltInToolCallArguments,
  BuiltInToolResult,
  BuiltInToolRunContext,
  ParsedBuiltInToolCall
} from "../tool/builtIn/builtInTool"
import { formatAttachmentLabel, formatByteCount } from "./attachmentContext"
import type { StoredAttachmentLocation } from "./attachmentFileStore"

/** Name the model calls the tool by. */
export const READ_ATTACHMENT_TOOL_NAME = "read_attachment"

/** Most lines one read returns, inclusive; also the count when it is omitted. */
export const MAXIMUM_READ_LINE_COUNT = 200

/** Most UTF-16 code units of the lines one read returns, inclusive. */
export const MAXIMUM_READ_CHARACTERS = 16_000

/** One attachment the tool can be asked for, with where its file is. */
export type ReadableAttachment = Readonly<{
  /** The stored attachment. */
  attachment: ConversationAttachment
  /** Where its file is. */
  location: StoredAttachmentLocation
}>

/**
 * Reads one stored attachment's file.
 *
 * @param location - The attachment's conversation, message, and name.
 * @returns The file's bytes, or undefined when the file is missing.
 * @throws If the file cannot be read for a reason other than being missing.
 */
export type ReadAttachmentFile = (
  location: StoredAttachmentLocation
) => Promise<Uint8Array | undefined>

/** Input of one parsed read. */
type AttachmentReadInput = Readonly<{
  /** Attachment to read, which is a text file. */
  readable: ReadableAttachment
  /** One-based line the read starts at. */
  startLine: number
  /** Most lines the read returns. */
  lineCount: number
}>

/** Outcome of parsing a read's arguments. */
type AttachmentReadInputResult =
  | Readonly<{
      /** The arguments describe a read. */
      status: "parsed"
      /** The read. */
      input: AttachmentReadInput
    }>
  | Readonly<{
      /** The arguments cannot describe a read. */
      status: "invalid"
      /** Explanation the model reads. */
      message: string
    }>

/** First code unit of a surrogate pair, which a cut must not separate from the second. */
const HIGH_SURROGATE_FIRST = 0xd8_00

/** Last high surrogate code unit. */
const HIGH_SURROGATE_LAST = 0xdb_ff

/** Lines selected for one read, and how the character limit ended them. */
type SelectedLines = Readonly<{
  /** Selected lines in file order. */
  lines: readonly string[]
  /**
   * How the character limit ended the selection: before the line that would
   * pass it, within a first line longer than it, or not at all.
   */
  cut: "before-line" | "within-line" | "none"
}>

/**
 * Lists the attachments of one user message with their files' locations.
 *
 * @param conversationId - UUIDv7 of the message's conversation.
 * @param message - Stored user message.
 * @returns Its attachments in number order, each with its file's location.
 */
function listMessageAttachments(
  conversationId: string,
  message: ConversationUserMessage
): readonly ReadableAttachment[] {
  return message.attachments.map((attachment) => ({
    attachment,
    location: { conversationId, messageId: message.id, name: attachment.name }
  }))
}

/**
 * Lists the attachments of a conversation's messages the reader can be asked
 * for.
 *
 * @param conversationId - UUIDv7 of the conversation the messages belong to.
 * @param messages - Stored messages in conversation order; replies have no
 * attachments and are skipped.
 * @returns Each user message's attachments in order, each with its file's
 * location; empty when no message has any.
 */
export function listReadableAttachments(
  conversationId: string,
  messages: readonly ConversationMessage[]
): readonly ReadableAttachment[] {
  return messages.flatMap((message) =>
    message.role === "user"
      ? listMessageAttachments(conversationId, message)
      : []
  )
}

/**
 * Answers whether the reader has a text file to read among attachments.
 *
 * @param attachments - Attachments of a conversation.
 * @returns True when one of them is a text attachment.
 */
export function hasReadableTextAttachment(
  attachments: readonly ReadableAttachment[]
): boolean {
  return attachments.some((readable) => readable.attachment.kind === "text")
}

/**
 * Builds the definition of the read-attachment tool.
 *
 * @returns The validated, frozen definition: it reads this machine, runs in
 * the backend, and states its limits to the model.
 */
export function buildReadAttachmentDefinition(): ToolDefinition {
  return toolDefinitionSchema.parse({
    name: READ_ATTACHMENT_TOOL_NAME,
    description: `Read lines of a text file the person attached to a message of this conversation. Each message lists its attached files as "[attachment N] name"; read a file by its number N. Returns at most ${MAXIMUM_READ_LINE_COUNT} lines or ${MAXIMUM_READ_CHARACTERS.toLocaleString("en-US")} characters per call and reports the file's total lines, so read a long file in parts. Images cannot be read: you see them with their message.`,
    group: "files",
    access: "reads",
    runner: "backend",
    arguments: [
      {
        type: "integer",
        name: "number",
        description: "Number of the attachment, as listed under its message."
      },
      {
        type: "integer",
        name: "start_line",
        description: "One-based line to start at. Omit it to start at line 1.",
        required: false
      },
      {
        type: "integer",
        name: "line_count",
        description: `Lines to return, at most ${MAXIMUM_READ_LINE_COUNT}. Omit it to return up to ${MAXIMUM_READ_LINE_COUNT}.`,
        required: false
      }
    ]
  })
}

/**
 * Formats the list of a conversation's attachments for an explanation.
 *
 * @param attachments - Readable attachments in number order.
 * @returns Their labels separated by commas, or a sentence for none.
 */
function formatAttachmentList(
  attachments: readonly ReadableAttachment[]
): string {
  if (attachments.length === 0) return "This conversation has no attachments."
  const labels = attachments.map((readable) =>
    formatAttachmentLabel(readable.attachment)
  )
  return `The attachments of this conversation are: ${labels.join(", ")}.`
}

/**
 * Parses an optional positive integer argument.
 *
 * @param value - Untrusted argument value; absent when the model omitted it.
 * @param argumentName - Name of the argument, for the explanation.
 * @param fallback - Value used when the argument is omitted.
 * @returns The integer, or an explanation when the value is not a positive
 * integer.
 */
function parsePositiveInteger(
  value: BuiltInToolCallArguments[string] | undefined,
  argumentName: string,
  fallback: number
): number | string {
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1)
    return `The ${argumentName} argument must be a whole number of at least 1.`
  return value
}

/**
 * Parses the arguments of one read.
 *
 * @param callArguments - Argument values that matched the definition in
 * type.
 * @param attachmentsByNumber - The conversation's attachments by number.
 * @returns The read, or an explanation naming the first problem: a number
 * no attachment has, an image, or a line argument that is not a positive
 * integer. A line count over the limit is lowered to it.
 */
function parseAttachmentReadInput(
  callArguments: BuiltInToolCallArguments,
  attachmentsByNumber: ReadonlyMap<number, ReadableAttachment>
): AttachmentReadInputResult {
  const { number } = callArguments
  const readable =
    typeof number === "number" ? attachmentsByNumber.get(number) : undefined
  if (readable === undefined)
    return Object.freeze({
      status: "invalid",
      message: `No attachment has the number ${String(number)}. ${formatAttachmentList([...attachmentsByNumber.values()])}`
    })
  if (readable.attachment.kind === "image")
    return Object.freeze({
      status: "invalid",
      message: `${formatAttachmentLabel(readable.attachment)} is an image, which you see with the message it was attached to; read_attachment reads text files only.`
    })
  const startLine = parsePositiveInteger(
    callArguments.start_line,
    "start_line",
    1
  )
  if (typeof startLine === "string")
    return Object.freeze({ status: "invalid", message: startLine })
  const lineCount = parsePositiveInteger(
    callArguments.line_count,
    "line_count",
    MAXIMUM_READ_LINE_COUNT
  )
  if (typeof lineCount === "string")
    return Object.freeze({ status: "invalid", message: lineCount })
  return Object.freeze({
    status: "parsed",
    input: Object.freeze({
      readable,
      startLine,
      lineCount: Math.min(lineCount, MAXIMUM_READ_LINE_COUNT)
    })
  })
}

/**
 * Splits a file's text into its lines.
 *
 * @param text - Decoded file text.
 * @returns The lines without their line breaks; a trailing line break ends
 * the last line rather than starting an empty one, and an empty file has no
 * lines.
 */
function splitLines(text: string): readonly string[] {
  if (text === "") return []
  const lines = text.split("\n").map((line) => line.replace(/\r$/, ""))
  if (lines.at(-1) === "") lines.pop()
  return lines
}

/**
 * Builds the start of a line longer than the character limit.
 *
 * @param line - A line longer than the limit.
 * @returns The line cut to the limit, one code unit shorter when the limit
 * would separate a surrogate pair, so the cut never ends in half a
 * character.
 */
function buildCutLine(line: string): string {
  const lastCodeUnit = line.charCodeAt(MAXIMUM_READ_CHARACTERS - 1)
  const length =
    lastCodeUnit >= HIGH_SURROGATE_FIRST && lastCodeUnit <= HIGH_SURROGATE_LAST
      ? MAXIMUM_READ_CHARACTERS - 1
      : MAXIMUM_READ_CHARACTERS
  return line.slice(0, length)
}

/**
 * Selects the lines one read returns.
 *
 * @param lines - Every line of the file.
 * @param input - The read's start line and line count.
 * @returns The lines from the start line, at most the line count, cut before
 * the line that would take the selection past the character limit; a first
 * line longer than the limit is cut within, as {@link buildCutLine} cuts it.
 */
function selectLines(
  lines: readonly string[],
  input: Pick<AttachmentReadInput, "startLine" | "lineCount">
): SelectedLines {
  const candidates = lines.slice(
    input.startLine - 1,
    input.startLine - 1 + input.lineCount
  )
  const selected: string[] = []
  let length = 0
  for (const line of candidates) {
    const nextLength = length + line.length + (selected.length > 0 ? 1 : 0)
    if (nextLength > MAXIMUM_READ_CHARACTERS) {
      if (selected.length > 0)
        return Object.freeze({
          lines: Object.freeze(selected),
          cut: "before-line"
        })
      return Object.freeze({
        lines: Object.freeze([buildCutLine(line)]),
        cut: "within-line"
      })
    }
    selected.push(line)
    length = nextLength
  }
  return Object.freeze({ lines: Object.freeze(selected), cut: "none" })
}

/**
 * Formats how the character limit cut a selection, for the read's header.
 *
 * @param selection - The selected lines.
 * @param startLine - One-based line the read started at.
 * @returns A sentence after the header, empty when nothing was cut: that the
 * response was cut before a line, or that the first line was cut within and
 * its rest cannot be read.
 */
function formatCutSentence(
  selection: SelectedLines,
  startLine: number
): string {
  const limit = MAXIMUM_READ_CHARACTERS.toLocaleString("en-US")
  switch (selection.cut) {
    case "none":
      return ""
    case "before-line":
      return ` The response was cut at ${limit} characters.`
    case "within-line":
      return ` Line ${startLine.toLocaleString("en-US")} was cut at ${limit} characters; the rest of it cannot be read.`
  }
}

/**
 * Builds the result of a read that could not happen.
 *
 * @param readable - Attachment the read was for.
 * @param reason - Why, as a clause after the label.
 * @returns A frozen failed result.
 */
function buildFailedReadResult(
  readable: ReadableAttachment,
  reason: string
): BuiltInToolResult {
  return Object.freeze({
    status: "failed",
    content: `Lys could not read ${formatAttachmentLabel(readable.attachment)}: ${reason}`
  })
}

/**
 * Builds the result of a read of a file's lines.
 *
 * @param input - The read.
 * @param lines - Every line of the file.
 * @returns A frozen succeeded result: a header naming the attachment, the
 * lines returned, the file's total lines and size, how the character limit
 * cut the lines when it did, and how to continue when lines follow; then
 * the lines. An empty file is reported as empty. A start line past the end
 * fails with the file's line count.
 */
function buildReadResult(
  input: AttachmentReadInput,
  lines: readonly string[]
): BuiltInToolResult {
  const { attachment } = input.readable
  const label = formatAttachmentLabel(attachment)
  const size = formatByteCount(attachment.sizeBytes)
  if (lines.length === 0)
    return Object.freeze({
      status: "succeeded",
      content: `${label} is empty (${size}).`,
      sources: Object.freeze([])
    })
  if (input.startLine > lines.length)
    return buildFailedReadResult(
      input.readable,
      `it has ${lines.length.toLocaleString("en-US")} lines, so there is no line ${input.startLine.toLocaleString("en-US")}.`
    )
  const selection = selectLines(lines, input)
  const lastLine = input.startLine + selection.lines.length - 1
  const range = `lines ${input.startLine.toLocaleString("en-US")}–${lastLine.toLocaleString("en-US")} of ${lines.length.toLocaleString("en-US")}`
  const cut = formatCutSentence(selection, input.startLine)
  const next =
    lastLine < lines.length
      ? ` Call read_attachment with start_line ${(lastLine + 1).toLocaleString("en-US")} to continue.`
      : ""
  return Object.freeze({
    status: "succeeded",
    content: `${label}, ${range} (${size}).${cut}${next}\n${selection.lines.join("\n")}`,
    sources: Object.freeze([])
  })
}

/**
 * Reads one attachment's lines.
 *
 * @param input - The read.
 * @param abortSignal - Stops the read.
 * @param readAttachmentFile - Reads the file.
 * @returns The lines, or why the file could not be read.
 * @throws The abort reason once the signal aborts, and a read failure other
 * than a missing file.
 */
async function runAttachmentRead(
  input: AttachmentReadInput,
  abortSignal: AbortSignal,
  readAttachmentFile: ReadAttachmentFile
): Promise<BuiltInToolResult> {
  abortSignal.throwIfAborted()
  const content = await readAttachmentFile(input.readable.location)
  abortSignal.throwIfAborted()
  if (content === undefined)
    return buildFailedReadResult(
      input.readable,
      "its file is missing from this machine."
    )
  return buildReadResult(input, splitLines(new TextDecoder().decode(content)))
}

/**
 * Owns one conversation's attachment list to read the text attachments the
 * model asks for by number, in parts.
 *
 * @remarks Implements {@link BuiltInTool}. Built for one turn with the
 * attachments the conversation holds when the turn starts, so the model can
 * reach exactly those files and nothing else: a file is found through its
 * stored location, never through a path the model supplies. Parsing refuses
 * a number no attachment has and an image before anything is read; a run
 * reads the file through the borrowed reader and returns the requested
 * lines within the line and character limits, or says the file is missing.
 * Owns no resource. Concurrency model: reentrant.
 */
export default class ReadAttachmentTool implements BuiltInTool {
  /** The conversation's attachments by number. */
  readonly #attachmentsByNumber: ReadonlyMap<number, ReadableAttachment>
  /** Reads an attachment's file; borrowed for the turn. */
  readonly #readAttachmentFile: ReadAttachmentFile

  /**
   * Creates the tool for one turn without touching the disk.
   *
   * @param attachments - Every attachment of the conversation, the new
   * message's included; copied, so later changes do not affect the tool.
   * @param readAttachmentFile - Reads an attachment's file, lent for the
   * turn.
   */
  public constructor(
    attachments: readonly ReadableAttachment[],
    readAttachmentFile: ReadAttachmentFile
  ) {
    this.#attachmentsByNumber = new Map(
      attachments.map((readable) => [readable.attachment.number, readable])
    )
    this.#readAttachmentFile = readAttachmentFile
  }

  /**
   * Implements {@link BuiltInTool.parseToolCall} for attachment reads.
   *
   * @param callArguments - The interface-defined argument values: `number`,
   * an optional `start_line`, and an optional `line_count`.
   * @returns The interface-defined outcome; `invalid` for a number no
   * attachment has, an image, or a line argument that is not a positive
   * integer.
   */
  public parseToolCall(
    callArguments: BuiltInToolCallArguments
  ): ParsedBuiltInToolCall {
    const parsed = parseAttachmentReadInput(
      callArguments,
      this.#attachmentsByNumber
    )
    if (parsed.status === "invalid") return parsed
    const readAttachmentFile = this.#readAttachmentFile
    return Object.freeze({
      status: "parsed",
      runToolCall: (context: BuiltInToolRunContext) =>
        runAttachmentRead(parsed.input, context.abortSignal, readAttachmentFile)
    })
  }
}
