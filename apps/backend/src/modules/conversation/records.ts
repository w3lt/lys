import type { ConversationSummary } from "@lys/protocol"
import type {
  Conversation,
  ConversationAssistantMessage,
  ConversationMetadata,
  ConversationUserMessage
} from "@lys/share"
import type { AssistantMessageCompletion } from "../chat/persistence"

/**
 * Position after which a conversation list page starts: the activity time and
 * identity of the last conversation on the previous page.
 */
export type ConversationListBoundary = Readonly<{
  /** Activity time of the boundary conversation, as listed. */
  updatedAt: string
  /** UUIDv7 of the boundary conversation, which breaks activity-time ties. */
  id: string
}>

/** Selection of one page of conversation summaries. */
export type ListConversationsInput = Readonly<{
  /**
   * Normalized search text matched case-insensitively against titles and
   * message content; empty matches every conversation.
   */
  query: string
  /** Last conversation of the previous page; undefined for the first page. */
  after: ConversationListBoundary | undefined
  /**
   * Inclusive maximum number of summaries, from one to
   * `MAXIMUM_CONVERSATION_LIST_PAGE_SIZE` of `@lys/protocol`.
   */
  limit: number
}>

/** One page of conversation summaries read from one consistent snapshot. */
export type ConversationPage = Readonly<{
  /**
   * Matching conversations after the boundary, newest activity first and
   * then by descending identity, at most the requested limit.
   */
  conversations: readonly ConversationSummary[]
  /** Number of stored conversations, independent of the query. */
  storedCount: number
  /** Number of stored conversations matching the query. */
  matchCount: number
  /** Whether a matching conversation follows the last one on this page. */
  hasMore: boolean
}>

/** One delta for a reply that is still streaming. */
export type UpdateAssistantMessageContentInput = Readonly<{
  /** UUIDv7 of the reply. */
  assistantMessageId: string
  /** Non-empty delta, appended after the stored text. */
  content: string
  /** Message timestamp stored with the delta. */
  updatedAt: string
}>

/** Terminal state for a reply that is still streaming. */
export type UpdateAssistantMessageStateInput = Readonly<{
  /** UUIDv7 of the reply. */
  assistantMessageId: string
  /** Terminal state; only a completed reply stores a finish reason. */
  completion: AssistantMessageCompletion
  /** Message timestamp stored with the state. */
  updatedAt: string
}>

/**
 * Value an operation returns once its writes are done, limited to values that
 * exist when it returns.
 *
 * @typeParam Result - Value the operation returns.
 * @remarks Resolves to `never` for a promise-like result, so an asynchronous
 * operation does not type-check: its work after the first `await` would run
 * after its transaction ended.
 */
export type SynchronousConversationTurnResult<Result> =
  Result extends PromiseLike<unknown> ? never : Result

/**
 * Turn-creation work run inside one write transaction.
 *
 * @typeParam Result - Value returned once the transaction commits.
 * @remarks The transaction is lent for this call only and refuses every call
 * once the operation returns.
 */
export type ConversationTurnOperation<Result> = (
  transaction: ConversationTurnTransaction
) => SynchronousConversationTurnResult<Result>

/**
 * Reads stored conversation history for the history reader.
 *
 * @remarks Each call reads one consistent snapshot of the store and changes
 * nothing. Returned values are independent copies, validated against the
 * shared conversation contracts. Borrowed from the store's owner without the
 * authority to close it; every call fails with `Database is closed` after the
 * owner closes the store. Every call also fails when the store cannot begin
 * or release its snapshot. Calls cannot be nested: a call made while another
 * operation on the store runs, such as a turn operation, fails with
 * `Database transactions cannot be nested` and leaves that operation
 * untouched. Concurrency model: single-owner, synchronous on the backend's
 * event loop.
 */
export interface ConversationRecordReader {
  /**
   * Reads one conversation and its transcript.
   *
   * @param conversationId - UUIDv7 to look up.
   * @returns The conversation with its messages in creation-time and then
   * identity order, or undefined when it is not stored.
   * @throws If the store is closed or a stored value violates the
   * conversation contract; the records stay usable.
   */
  findConversation(conversationId: string): Conversation | undefined
  /**
   * Reads one page of conversation summaries and both counts.
   *
   * @param input - Search text, page boundary, and page size.
   * @returns The page; each summary previews its latest matching message with
   * content, or its latest message with content when only the title matches.
   * @throws If the store is closed or a stored value violates the summary
   * contract; the records stay usable.
   */
  listConversations(input: ListConversationsInput): ConversationPage
}

/**
 * Applies user edits to stored conversations for the history editor.
 *
 * @remarks Each call is one write transaction that commits before it returns
 * and changes nothing when it fails, including when the store cannot begin or
 * commit it; an `AggregateError` then holds that failure followed by each
 * failure to roll back. Borrowed from the store's owner without the authority
 * to close it; every call fails with `Database is closed` after the owner
 * closes the store. Calls cannot be nested: a call made while another
 * operation on the store runs fails with
 * `Database transactions cannot be nested` and leaves that operation
 * untouched. Concurrency model: single-owner, synchronous on the backend's
 * event loop.
 */
export interface ConversationRecordEditor {
  /**
   * Replaces a conversation's title without changing its activity time or
   * transcript.
   *
   * @param conversationId - UUIDv7 to rename.
   * @param title - Validated title, stored as given.
   * @returns The resulting metadata, or undefined when the conversation is not
   * stored. Repeating the call stores the same title.
   * @throws If the store is closed or the renamed conversation violates the
   * metadata contract; the title is then unchanged.
   */
  updateConversationTitle(
    conversationId: string,
    title: string
  ): ConversationMetadata | undefined
  /**
   * Permanently deletes a conversation and every message in it.
   *
   * @param conversationId - UUIDv7 to delete.
   * @returns True when it was stored; false when it was already absent.
   * @throws If the store is closed or the deletion fails.
   */
  deleteConversation(conversationId: string): boolean
}

/**
 * Persists chat turns and their replies for the turn writer: atomic turn
 * creation, reply content and state, startup recovery, and generated titles.
 *
 * @remarks Every call runs in one write transaction that commits before it
 * returns and changes nothing when it fails, including when the store cannot
 * begin or commit it; an `AggregateError` then holds that failure followed by
 * each failure to roll back. Deleted rows and finalized replies reject late
 * writes through false results. Borrowed from the store's owner without the
 * authority to close it; every call fails with `Database is closed` after the
 * owner closes the store. Calls cannot be nested: a call made while another
 * operation on the store runs, including from inside a turn operation, fails
 * with `Database transactions cannot be nested` and leaves that operation
 * untouched. Concurrency model: single-owner, synchronous on the backend's
 * event loop.
 */
export interface ConversationTurnRecordWriter {
  /**
   * Runs turn-creation work in one write transaction.
   *
   * @typeParam Result - Value produced by the operation.
   * @param operation - Synchronous work; its transaction is valid for this
   * call only.
   * @returns The operation's result after everything it wrote is committed.
   * @throws The operation's or the commit's failure, after everything the
   * operation wrote is rolled back.
   * @throws `Database operations must be synchronous` when the operation
   * returns a promise-like value; its writes are rolled back, and writes after
   * its first `await` fail with `Database operation has ended`.
   * @throws If the store is closed, the call is nested, or the store cannot
   * begin the write, for example while another connection holds its write
   * lock; the operation does not run.
   * @throws An `AggregateError` holding the operation's or the commit's
   * failure followed by each failure to roll back.
   */
  handleConversationTurnWriteRequest<Result>(
    operation: ConversationTurnOperation<Result>
  ): Result
  /**
   * Marks every reply still streaming, in every conversation, as interrupted.
   *
   * @param updatedAt - Message timestamp stored on each interrupted reply.
   * @remarks Keeps each reply's text, has no finish reason, and changes no
   * conversation's activity time. Repeating the call changes nothing more.
   * @throws If the store is closed or the write fails.
   */
  updateAllStreamingAssistantMessagesToInterrupted(updatedAt: string): void
  /**
   * Appends a delta to a reply that is still streaming.
   *
   * @param input - Reply, delta, and message timestamp.
   * @returns True when appended; false when the reply is finalized or not
   * stored, which changes nothing.
   * @throws If the store is closed or the write fails.
   * @remarks An appended delta also moves its conversation's activity time
   * forward, to the store's current time when that is later than the stored
   * activity time and otherwise to a later time the store chooses.
   */
  updateAssistantMessageContent(
    input: UpdateAssistantMessageContentInput
  ): boolean
  /**
   * Finalizes a reply that is still streaming, keeping its text and its
   * conversation's activity time.
   *
   * @param input - Reply, terminal state, and message timestamp.
   * @returns True when finalized; false when it already was or is not stored,
   * which changes nothing.
   * @throws If the store is closed or the write fails.
   */
  updateAssistantMessageState(input: UpdateAssistantMessageStateInput): boolean
  /**
   * Stores a title for a conversation that has none, keeping its activity
   * time.
   *
   * @param conversationId - UUIDv7 of the conversation.
   * @param title - Validated title, stored as given.
   * @returns True when stored; false when the conversation already has a title
   * or is not stored, which changes nothing.
   * @throws If the store is closed or the write fails.
   */
  updateUntitledConversationTitle(
    conversationId: string,
    title: string
  ): boolean
}

/**
 * Reads and writes one turn's records inside the write transaction lent to a
 * {@link ConversationTurnOperation}.
 *
 * @remarks Every change is part of the enclosing transaction: it commits only
 * when the operation returns and is rolled back when it throws. Valid only
 * while that operation runs; afterwards every call fails with
 * `Database operation has ended`, or with `Database is closed` once the store
 * is closed, and changes nothing. Concurrency model: single-owner, confined to
 * the running operation.
 */
export interface ConversationTurnTransaction {
  /**
   * Marks the conversation's replies that are still streaming as interrupted.
   *
   * @param conversationId - UUIDv7 of the conversation; an absent one changes
   * nothing.
   * @param updatedAt - Message timestamp stored on each interrupted reply.
   * @remarks Keeps each reply's text, stores no finish reason, and keeps the
   * conversation's activity time; finalized replies and other conversations
   * are unchanged.
   * @throws If the transaction has ended or the write fails.
   */
  updateStreamingAssistantMessagesToInterrupted(
    conversationId: string,
    updatedAt: string
  ): void
  /**
   * Stores a new conversation exactly as given.
   *
   * @param metadata - Valid metadata whose identity is not stored yet.
   * @throws If the transaction has ended or the write fails.
   * @throws The store's own error when the identity is already stored, which
   * breaks the precondition.
   */
  createConversation(metadata: ConversationMetadata): void
  /**
   * Reads one conversation and its transcript, including this transaction's
   * writes.
   *
   * @param conversationId - UUIDv7 to look up.
   * @returns The conversation with its messages in creation-time and then
   * identity order, or undefined when it is not stored.
   * @throws If the transaction has ended or a stored value violates the
   * conversation contract.
   */
  findConversation(conversationId: string): Conversation | undefined
  /**
   * Appends a user message exactly as given.
   *
   * @param conversationId - UUIDv7 of a stored conversation.
   * @param message - Valid message whose identity is not stored yet.
   * @throws If the transaction has ended or the write fails.
   * @throws The store's own error when the conversation is not stored or the
   * message's identity is, which breaks the precondition.
   * @remarks Moves the conversation's activity time forward: to the message's
   * time when that is later than the stored activity time, and otherwise to a
   * later time the store chooses.
   */
  createUserMessage(
    conversationId: string,
    message: ConversationUserMessage
  ): void
  /**
   * Appends an assistant message exactly as given, including its text and
   * state.
   *
   * @param conversationId - UUIDv7 of a stored conversation.
   * @param message - Valid message whose identity is not stored yet.
   * @throws If the transaction has ended or the write fails.
   * @throws The store's own error when the conversation is not stored or the
   * message's identity is, which breaks the precondition.
   * @remarks Moves the conversation's activity time forward, as
   * {@link ConversationTurnTransaction.createUserMessage} does.
   */
  createAssistantMessage(
    conversationId: string,
    message: ConversationAssistantMessage
  ): void
}
