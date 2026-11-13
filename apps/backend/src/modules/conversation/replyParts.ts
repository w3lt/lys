import type { ReplyPart, ToolCallReplyPart } from "@lys/share"
import {
  buildReplyPart,
  type ReplyPartDraft,
  type ReplyToolCallChange
} from "../agent/replyPartSequence"
import type { ReplyPartWriter } from "../chat/persistence"
import type { ReplyPartRecordWriter } from "./records"

/**
 * Retains borrowed reply-part records to store the parts of streaming
 * replies and the sources their tool calls read.
 *
 * @remarks Each operation reads the current time once and passes it to
 * everything it stores, so every timestamp it writes on a part comes from
 * that one reading. The conversation's activity time is the exception: when
 * a part's content changes, as an appended fragment or a call's result does,
 * the schema's message-update trigger sets it from SQLite's own clock. Every
 * operation is one write transaction that commits before it returns. Owns no
 * resource: the records' owner closes the store, after which every operation
 * fails with `Database is closed`. Concurrency model: single-owner,
 * synchronous on the backend's event loop. Implements
 * {@link ReplyPartWriter}.
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
