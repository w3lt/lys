import type { ConversationSummary } from "@lys/protocol"
import type {
  Conversation,
  ConversationAssistantMessage,
  ConversationMetadata,
  ConversationUserMessage,
  JobReport,
  ReplyPart,
  ToolCallReplyPart
} from "@lys/share"
import type { AssistantMessageCompletion } from "../agent/agent"
import type { ReplyToolCallChange } from "../agent/replyPartSequence"

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

/** Selection of one page of main conversation summaries. */
export type ListConversationsInput = Readonly<{
  /**
   * Normalized search text matched case-insensitively against titles, the
   * person's messages, and each text part of a reply, but not reasoning,
   * tool calls, or wake-up messages; empty matches every main conversation.
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

/**
 * One page of main conversation summaries read from one consistent snapshot.
 * A job is neither listed nor counted.
 */
export type ConversationPage = Readonly<{
  /**
   * Matching main conversations after the boundary, newest activity first
   * and then by descending identity, at most the requested limit.
   */
  conversations: readonly ConversationSummary[]
  /** Number of stored main conversations, independent of the query. */
  storedCount: number
  /** Number of stored main conversations matching the query. */
  matchCount: number
  /** Whether a matching conversation follows the last one on this page. */
  hasMore: boolean
}>

/** One new part for a reply that is still streaming. */
export type CreateReplyPartInput = Readonly<{
  /** UUIDv7 of the reply. */
  assistantMessageId: string
  /**
   * Valid part whose identity is not stored yet, with its times; it follows
   * every part the reply already has.
   */
  part: ReplyPart
}>

/** One fragment for a reasoning or text part of a reply still streaming. */
export type UpdateReplyPartContentInput = Readonly<{
  /** UUIDv7 of the reply. */
  assistantMessageId: string
  /** UUIDv7 of the reasoning or text part. */
  partId: string
  /** Non-empty fragment, appended after the part's stored content. */
  content: string
  /** Part timestamp stored with the fragment. */
  updatedAt: string
}>

/** One change of a tool call of a reply still streaming. */
export type UpdateReplyToolCallInput = Readonly<{
  /** UUIDv7 of the reply. */
  assistantMessageId: string
  /** UUIDv7 of the call, the tool-call part's identity. */
  toolCallId: string
  /** The call's next state; a succeeded call's sources are stored with it. */
  change: ReplyToolCallChange
  /** Part timestamp stored with the change. */
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

/** One report to deliver with the user message of a turn. */
export type JobReportDelivery = Readonly<{
  /** UUIDv7 of a stored report that is not delivered yet. */
  reportId: string
  /**
   * UUIDv7 of the stored user message of the turn that delivers the report,
   * in the conversation the report's job was started from.
   */
  messageId: string
  /**
   * Text the delegator reads, stored in place of the report's text;
   * non-empty for a note and for a `failed` report.
   */
  content: string
  /**
   * Numbers of the sources of the delegator's conversation the text cites,
   * ascending; empty when it cites none.
   */
  sourceNumbers: readonly number[]
}>

/**
 * The records one turn operation is lent, over the same write transaction.
 */
export type ConversationTurnRecords = Readonly<{
  /** Reads and writes of the turn's conversation and its messages. */
  turn: ConversationTurnTransaction
  /** What storing the turn changes about jobs. */
  jobs: JobTurnTransaction
}>

/**
 * Turn-creation work run inside one write transaction.
 *
 * @typeParam Result - Value returned once the transaction commits.
 * @remarks The transaction and the job records are lent for this call only,
 * over the same write, and refuse every call once the operation returns.
 */
export type ConversationTurnOperation<Result> = (
  transaction: ConversationTurnTransaction,
  jobs: JobTurnTransaction
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
   * Reads one conversation's metadata without its transcript.
   *
   * @param conversationId - UUIDv7 to look up.
   * @returns The metadata of a main conversation or of a job, which carries
   * its parent, its number, and its delegator; or undefined when the
   * conversation is not stored. Its messages, sources, and jobs are not
   * read, so a conversation whose transcript violates the conversation
   * contract is still read.
   * @throws If the store is closed or the stored metadata violates the
   * metadata contract; the records stay usable.
   */
  findConversationMetadata(
    conversationId: string
  ): ConversationMetadata | undefined
  /**
   * Reads one page of main conversation summaries and both counts; a job
   * is neither listed nor counted.
   *
   * @param input - Search text, page boundary, and page size.
   * @returns The page; each summary previews its latest matching message of
   * the person or reply text part, or its latest one when only the title
   * matches; reasoning, tool calls, and wake-up messages are never
   * previewed.
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
   * Permanently deletes a conversation and every message in it, and with it
   * every job started from it and the jobs' reports.
   *
   * @param conversationId - UUIDv7 to delete.
   * @returns True when it was stored; false when it was already absent.
   * @throws If the store is closed or the deletion fails.
   */
  deleteConversation(conversationId: string): boolean
}

/**
 * Persists chat turns and their replies for the turn writer: atomic turn
 * creation, reply state, startup recovery, and generated titles.
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
   * @param operation - Synchronous work; the transaction and the job records
   * it is lent are valid for this call only.
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
   * @remarks Keeps each reply's parts, has no finish reason, and changes no
   * conversation's activity time. Each such reply's tool calls still waiting
   * for approval or running become interrupted too, keeping their
   * `updatedAt`: the reply stopped working when the earlier process ended,
   * not now. Repeating the call changes nothing more.
   * @throws If the store is closed or the write fails.
   */
  updateAllStreamingAssistantMessagesToInterrupted(updatedAt: string): void
  /**
   * Finalizes a reply that is still streaming, keeping its parts and its
   * conversation's activity time.
   *
   * @param input - Reply, terminal state, and message timestamp.
   * @returns True when finalized; false when it already was or is not stored,
   * which changes nothing.
   * @throws If the store is closed or the write fails.
   * @remarks In the same transaction, the reply's tool calls still waiting
   * for approval or running become interrupted, with the same timestamp.
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
 * Persists the parts of replies that are still streaming, and the sources
 * their tool calls read, for the reply-part writer.
 *
 * @remarks Every call runs in one write transaction that commits before it
 * returns and changes nothing when it fails, including when the store cannot
 * begin or commit it; an `AggregateError` then holds that failure followed by
 * each failure to roll back. A reply that is finalized or not stored refuses
 * every write through a false or undefined result. A new or changed part
 * moves its conversation's activity time forward, as a new message does; a
 * tool call's state change without a result does not. Borrowed from the
 * store's owner without the authority to close it; every call fails with
 * `Database is closed` after the owner closes the store. Calls cannot be
 * nested. Concurrency model: single-owner, synchronous on the backend's event
 * loop.
 */
export interface ReplyPartRecordWriter {
  /**
   * Stores a part after every part its reply has.
   *
   * @param input - Reply and the complete part.
   * @returns True when stored; false when the reply is finalized or not
   * stored, which changes nothing.
   * @throws If the store is closed or the write fails, including when the
   * part's identity is already stored, which breaks the precondition.
   */
  createReplyPart(input: CreateReplyPartInput): boolean
  /**
   * Appends a fragment to a reasoning or text part of a reply.
   *
   * @param input - Reply, part, fragment, and part timestamp.
   * @returns True when appended; false when the reply is finalized or not
   * stored, or the part is not one of its reasoning or text parts, which
   * changes nothing.
   * @throws If the store is closed or the write fails.
   */
  updateReplyPartContent(input: UpdateReplyPartContentInput): boolean
  /**
   * Stores one change of a reply's tool call and, for a succeeded call, its
   * sources.
   *
   * @param input - Reply, call, change, and part timestamp.
   * @returns The call as stored, or undefined when the reply is finalized or
   * not stored, or the call is not one of its calls in a state the change
   * follows (`running` and `rejected` follow `awaiting-approval`;
   * `succeeded` and `failed` follow `running`), which changes nothing.
   * @throws If the store is closed, the write fails, or the conversation
   * stores a source's number for another URL or its URL under another
   * number; nothing is then changed. A source whose number and URL the
   * conversation already stores together keeps its stored row and title.
   */
  updateReplyToolCall(
    input: UpdateReplyToolCallInput
  ): ToolCallReplyPart | undefined
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
   * @remarks Keeps each reply's parts, stores no finish reason, and keeps the
   * conversation's activity time; each such reply's tool calls still waiting
   * for approval or running become interrupted too. Finalized replies and
   * other conversations are unchanged.
   * @throws If the transaction has ended or the write fails.
   */
  updateStreamingAssistantMessagesToInterrupted(
    conversationId: string,
    updatedAt: string
  ): void
  /**
   * Stores a new conversation exactly as given: a main conversation, or a
   * job with its parent and its number.
   *
   * @param metadata - Valid metadata whose identity is not stored yet. A job
   * names a stored parent, a number no job of that parent has, and a title.
   * Its delegator's code is not stored: reads take it from the parent.
   * @throws If the transaction has ended or the write fails.
   * @throws The store's own error when the identity is already stored, or
   * when a job's parent is not stored, its number is one a job of that parent
   * has, or it has no title, each of which breaks the precondition.
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
   * Appends a user message exactly as given, with its attachments and who
   * wrote it.
   *
   * @param conversationId - UUIDv7 of a stored conversation.
   * @param message - Valid message whose identity is not stored yet; its
   * attachments carry numbers the conversation does not store yet. Its
   * reports are not stored by this call:
   * {@link JobTurnTransaction.updateJobReportToDelivered} delivers a report
   * with a stored message.
   * @param jobCallId - UUIDv7 of the stored `delegate_work` call that sends
   * a job message; given exactly when the message's origin is `delegator`.
   * @throws If the transaction has ended or the write fails.
   * @throws `A job call is given exactly with a delegator's message` when a
   * call is given with a message a delegator did not write, or none with one
   * a delegator wrote; nothing is then written.
   * @throws The store's own error when the conversation is not stored, the
   * message's identity is, the call is not stored, or an attachment's number
   * is stored for the conversation already, which breaks the precondition.
   * @remarks Moves the conversation's activity time forward: to the message's
   * time when that is later than the stored activity time, and otherwise to a
   * later time the store chooses. Each attachment is stored under the
   * message, and is read back with it by `findConversation`.
   */
  createUserMessage(
    conversationId: string,
    message: ConversationUserMessage,
    jobCallId: string | undefined
  ): void
  /**
   * Appends an assistant message exactly as given, including its state.
   *
   * @param conversationId - UUIDv7 of a stored conversation.
   * @param message - Valid message whose identity is not stored yet and that
   * has no parts; its parts are stored later, one by one.
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

/**
 * Reads and writes what storing one turn changes about jobs, inside the
 * write transaction lent to a {@link ConversationTurnOperation}: the title
 * of a continued job, and the delivery of the reports that wait for the
 * turn's conversation.
 *
 * @remarks Every change is part of the enclosing transaction: it commits only
 * when the operation returns and is rolled back when it throws. No call
 * changes the activity time of a conversation. Valid only while that
 * operation runs; afterwards every call fails with
 * `Database operation has ended`, or with `Database is closed` once the store
 * is closed, and changes nothing. Concurrency model: single-owner, confined
 * to the running operation.
 */
export interface JobTurnTransaction {
  /**
   * Replaces a job's title with the title of the job message that continues
   * it, and keeps everything else of the job.
   *
   * @param jobId - UUIDv7 of the job: its conversation. A main conversation
   * and an identity that is not stored are left as they are.
   * @param title - Non-empty title, stored as given.
   * @throws If the transaction has ended or the write fails.
   * @throws The store's own error when the title is empty, which breaks the
   * precondition; the stored title is then kept.
   */
  updateJobTitle(jobId: string, title: string): void
  /**
   * Lists the reports of a conversation's jobs that are not delivered yet,
   * of every kind, including this transaction's writes.
   *
   * @param parentConversationId - UUIDv7 of the conversation the jobs were
   * started from.
   * @returns The reports, oldest first and then by identity, each with the
   * number and the agent of its job; none when the conversation has no jobs
   * or is not stored.
   * @throws If the transaction has ended or a stored report violates the
   * report contract.
   */
  listUndeliveredJobReports(parentConversationId: string): readonly JobReport[]
  /**
   * Marks one report as delivered with a message, and stores the text and
   * the source numbers its delegator reads.
   *
   * @param delivery - The report, the delivering message, and what the
   * delegator reads.
   * @throws If the transaction has ended or the write fails.
   * @throws `Job report is not waiting for delivery` when the report is not
   * stored or is already delivered; nothing is then changed, so a report is
   * delivered once.
   * @throws The store's own error when the message is not stored, or the
   * text of a note or of a `failed` report is empty, each of which breaks the
   * precondition; the report then stays undelivered.
   */
  updateJobReportToDelivered(delivery: JobReportDelivery): void
}
