import {
  replyPartSchema,
  type ReplyPart,
  type ToolCallReplyPart
} from "@lys/share"
import { v7 as uuidv7 } from "uuid"
import type {
  ReplyPartDraft,
  ReplyToolCallChange
} from "../agent/replyPartSequence"
import type { ReplyPartWriter } from "../chat/persistence"
import type { ReplyPartRecordWriter } from "./records"

/**
 * Builds the complete part a draft describes.
 *
 * @param draft - Part the agent asks to store.
 * @param now - Time of the operation, stored as both of the part's times.
 * @returns The validated part; a reasoning or text part gets a new UUIDv7, a
 * tool call keeps its own identifier and shows no sources yet.
 * @throws If the draft breaks the part contract, such as empty text or an
 * empty failure message.
 */
function buildReplyPart(draft: ReplyPartDraft, now: string): ReplyPart {
  if (draft.kind !== "tool-call")
    return replyPartSchema.parse({
      kind: draft.kind,
      id: uuidv7(),
      round: draft.round,
      createdAt: now,
      updatedAt: now,
      content: draft.content
    })
  return replyPartSchema.parse({
    ...draft,
    sourceNumbers: [],
    createdAt: now,
    updatedAt: now
  })
}

/**
 * Retains borrowed reply-part records to store the parts of streaming
 * replies and the sources their tool calls read.
 *
 * @remarks Each operation reads the current time once and passes it to
 * everything it stores; nothing it calls reads the clock. Every operation is
 * one write transaction that commits before it returns. Owns no resource:
 * the records' owner closes the store, after which every operation fails with
 * `Database is closed`. Concurrency model: single-owner, synchronous on the
 * backend's event loop. Implements {@link ReplyPartWriter}.
 */
export default class StoredReplyParts implements ReplyPartWriter {
  /** Borrowed records for every part change. */
  readonly #replyPartRecordWriter: ReplyPartRecordWriter

  /**
   * Retains borrowed records without performing storage work.
   * @param replyPartRecordWriter - Reply-part records lent by the
   * composition root.
   */
  public constructor(replyPartRecordWriter: ReplyPartRecordWriter) {
    this.#replyPartRecordWriter = replyPartRecordWriter
  }

  /**
   * Implements {@link ReplyPartWriter.createReplyPart}, stamping the part with
   * the current time.
   * @param assistantMessageId - Interface-defined reply.
   * @param draft - Interface-defined part.
   * @returns The interface-defined stored part or absence.
   * @throws The interface-defined validation and persistence failures.
   */
  public createReplyPart(
    assistantMessageId: string,
    draft: ReplyPartDraft
  ): ReplyPart | undefined {
    const part = buildReplyPart(draft, new Date().toISOString())
    return this.#replyPartRecordWriter.createReplyPart({
      assistantMessageId,
      part
    })
      ? part
      : undefined
  }

  /**
   * Implements {@link ReplyPartWriter.updateReplyPartContent}, storing the
   * current time as the part's update time.
   * @param assistantMessageId - Interface-defined reply.
   * @param partId - Interface-defined part.
   * @param content - Interface-defined fragment.
   * @returns The interface-defined stored time or absence.
   * @throws The interface-defined empty-fragment and persistence failures.
   */
  public updateReplyPartContent(
    assistantMessageId: string,
    partId: string,
    content: string
  ): string | undefined {
    if (content.length === 0)
      throw new Error("Reply part fragment must not be empty")
    const updatedAt = new Date().toISOString()
    return this.#replyPartRecordWriter.updateReplyPartContent({
      assistantMessageId,
      partId,
      content,
      updatedAt
    })
      ? updatedAt
      : undefined
  }

  /**
   * Implements {@link ReplyPartWriter.updateReplyToolCall}, storing the
   * current time as the call's update time.
   * @param assistantMessageId - Interface-defined reply.
   * @param toolCallId - Interface-defined call.
   * @param change - Interface-defined next state.
   * @returns The interface-defined stored call or absence.
   * @throws The interface-defined persistence failures.
   */
  public updateReplyToolCall(
    assistantMessageId: string,
    toolCallId: string,
    change: ReplyToolCallChange
  ): ToolCallReplyPart | undefined {
    return this.#replyPartRecordWriter.updateReplyToolCall({
      assistantMessageId,
      toolCallId,
      change,
      updatedAt: new Date().toISOString()
    })
  }
}
