import type {
  ConversationAssistantMessageFinishReason,
  ConversationAssistantMessageStatus,
  Job,
  JobReportKind
} from "@lys/share"

/** One reply, named by its conversation and its own identity. */
export type ReplyAddress = Readonly<{
  /** UUIDv7 of the conversation that holds the reply. */
  conversationId: string
  /** UUIDv7 of the reply, an assistant message of that conversation. */
  assistantMessageId: string
}>

/** One stored job with the conversation it belongs to. */
export type JobRecord = Readonly<{
  /** UUIDv7 of the conversation the job was started from. */
  parentConversationId: string
  /** The job as its card shows it. */
  job: Job
}>

/** One stored reply as the end of its generation is reported. */
export type EndedReplyRecord = Readonly<{
  /** UUIDv7 of the conversation that holds the reply. */
  conversationId: string
  /**
   * UUIDv7 of the conversation that conversation was started from; null when
   * it is a main conversation.
   */
  parentConversationId: string | null
  /** Stored state of the reply; `streaming` while it has not ended. */
  status: ConversationAssistantMessageStatus
  /** Why a completed reply finished; null in every other state. */
  finishReason: ConversationAssistantMessageFinishReason | null
  /**
   * Text parts of the reply's last round, joined in order; empty when that
   * round wrote none. The last round is the highest one any part of the reply
   * belongs to.
   */
  lastRoundText: string
}>

/** What an end report says: every kind of report except the progress note. */
export type EndReportKind = Exclude<JobReportKind, "note">

/** One end report to store for a reply of a job. */
export type NewEndReport = Readonly<{
  /** UUIDv7 identity of the report, which is not stored yet. */
  id: string
  /** UUIDv7 of the job: its conversation. */
  jobId: string
  /** UUIDv7 of the reply of that job whose end the report tells. */
  replyId: string
  /** How the reply ended. */
  kind: EndReportKind
  /** Non-empty title of the job message the reply answers. */
  title: string
  /** Text of the report; non-empty for a `failed` report. */
  content: string
  /** Time the report is written. */
  createdAt: string
}>

/** One progress note to store for a reply of a job. */
export type NewProgressNote = Readonly<{
  /** UUIDv7 identity of the note, which is not stored yet. */
  id: string
  /** UUIDv7 of the job: its conversation. */
  jobId: string
  /** UUIDv7 of the reply of that job that sends the note. */
  replyId: string
  /** Non-empty title of the job message the reply answers. */
  title: string
  /** Non-empty text of the note. */
  content: string
  /** Time the note is written. */
  createdAt: string
}>

/**
 * Reads the jobs of conversations for the delegation policies.
 *
 * @remarks A job's reply is its newest assistant message, by creation time
 * and then identity. The job's state, its latest note, and its reply are read
 * from that reply, and its call ids from its job messages. Each call reads
 * one consistent snapshot of the store and changes nothing. Returned values
 * are independent copies, validated against the shared job contract. Borrowed
 * from the store's owner without the authority to close it; every call fails
 * with `Database is closed` after the owner closes the store. Every call also
 * fails when the store cannot begin or release its snapshot. Calls cannot be
 * nested: a call made while another operation on the store runs, such as a
 * turn operation, fails with `Database transactions cannot be nested` and
 * leaves that operation untouched. Concurrency model: single-owner,
 * synchronous on the backend's event loop.
 */
export interface JobReader {
  /**
   * Lists the jobs started from one conversation.
   *
   * @param parentConversationId - UUIDv7 of the conversation.
   * @returns Its jobs in number order; none when it has no jobs or is not
   * stored.
   * @throws If the store is closed or a stored job violates the job contract,
   * as a job without a job message or a reply does; the records stay usable.
   */
  listJobs(parentConversationId: string): readonly Job[]
  /**
   * Reads one job by its identity.
   *
   * @param jobId - UUIDv7 of the job: its conversation.
   * @returns The job with the conversation it belongs to, or undefined when
   * no conversation has the identity or the one that has it is a main
   * conversation.
   * @throws If the store is closed or the stored job violates the job
   * contract; the records stay usable.
   */
  findJob(jobId: string): JobRecord | undefined
  /**
   * Reads one job by its number in the conversation it belongs to.
   *
   * @param parentConversationId - UUIDv7 of the conversation the job was
   * started from.
   * @param jobNumber - The job's number in that conversation, from 1.
   * @returns The job, or undefined when that conversation has no job with the
   * number; another conversation's job with the same number is never
   * returned.
   * @throws If the store is closed or the stored job violates the job
   * contract; the records stay usable.
   */
  findJobByNumber(
    parentConversationId: string,
    jobNumber: number
  ): Job | undefined
  /**
   * Reads how many job messages a conversation's jobs received since the
   * person last wrote in it.
   *
   * @param parentConversationId - UUIDv7 of the conversation.
   * @returns The number of job messages, over all of the conversation's jobs,
   * created at or after the time of the latest message the person wrote in
   * the conversation; every one of them when the person wrote none there; 0
   * when the conversation has no jobs or is not stored.
   * @throws If the store is closed.
   * @remarks A wake-up message is the backend's, not the person's, so it does
   * not start the count again.
   */
  getJobMessageCountSincePersonMessage(parentConversationId: string): number
}

/**
 * Reads what the replies and the reports of conversations and their jobs wait
 * for, for the delegation policies.
 *
 * @remarks Each call reads one consistent snapshot of the store and changes
 * nothing. Returned values are independent copies. Borrowed from the store's
 * owner without the authority to close it; every call fails with
 * `Database is closed` after the owner closes the store. Every call also
 * fails when the store cannot begin or release its snapshot. Calls cannot be
 * nested: a call made while another operation on the store runs, such as a
 * turn operation, fails with `Database transactions cannot be nested` and
 * leaves that operation untouched. Concurrency model: single-owner,
 * synchronous on the backend's event loop.
 */
export interface JobActivityReader {
  /**
   * Answers whether a report that wakes the delegator waits to be delivered.
   *
   * @param parentConversationId - UUIDv7 of the delegator's conversation.
   * @returns True when a `result` or `failed` report of one of the
   * conversation's jobs is not delivered; false otherwise, also when the
   * conversation has no jobs or is not stored. A note, a `stopped` report,
   * and an `interrupted` report never wake.
   * @throws If the store is closed.
   */
  hasUndeliveredWakingReport(parentConversationId: string): boolean
  /**
   * Answers whether a reply of one conversation is streaming.
   *
   * @param conversationId - UUIDv7 of the conversation; the replies of its
   * jobs do not count.
   * @returns True while one of the conversation's own replies is streaming;
   * false otherwise, also when the conversation is not stored.
   * @throws If the store is closed.
   */
  hasStreamingReply(conversationId: string): boolean
  /**
   * Lists the streaming replies of one conversation and of every job below
   * it, at any depth.
   *
   * @param conversationId - UUIDv7 of the conversation.
   * @returns The conversation's own streaming reply first, then those of the
   * jobs below it in the order the jobs were created. Empty when none of them
   * streams or the conversation is not stored.
   * @throws If the store is closed or a stored identity violates the
   * conversation contract; the records stay usable.
   */
  listStreamingReplies(conversationId: string): readonly ReplyAddress[]
  /**
   * Reads one stored reply as the end of its generation is reported: its
   * conversation, its state, and the text of its last round.
   *
   * @param assistantMessageId - UUIDv7 of the reply.
   * @returns The record, whatever state the reply is in, or undefined when no
   * reply has the identity; a user message or a part of a reply is not a
   * reply.
   * @throws If the store is closed or a stored value violates the
   * conversation contract; the records stay usable.
   */
  findEndedReply(assistantMessageId: string): EndedReplyRecord | undefined
}

/**
 * Stores the reports jobs send to their delegators, for the delegation
 * policies.
 *
 * @remarks Every call runs in one write transaction that commits before it
 * returns and changes nothing when it fails, including when the store cannot
 * begin or commit it; an `AggregateError` then holds that failure followed by
 * each failure to roll back. A report is stored undelivered and without cited
 * sources; the turn that delivers it stores both. A reply that is not a reply
 * of the named job, because either is deleted or never was stored, refuses
 * every write through a false result. Storing a report leaves the job's
 * activity time as it is. Borrowed from the store's owner without the
 * authority to close it; every call fails with `Database is closed` after the
 * owner closes the store. Calls cannot be nested: a call made while another
 * operation on the store runs fails with
 * `Database transactions cannot be nested` and leaves that operation
 * untouched. Concurrency model: single-owner, synchronous on the backend's
 * event loop.
 */
export interface JobReportWriter {
  /**
   * Stores the report of how a reply of a job ended, at most once for a
   * reply.
   *
   * @param report - The complete report.
   * @returns True when stored; false when the reply is not a reply of that
   * job or already has an end report, which changes nothing. The job's notes
   * are kept.
   * @throws If the store is closed or the write fails, including when the
   * report's identity is already stored, its title is empty, or a `failed`
   * report has no text, each of which breaks the precondition.
   */
  createEndReport(report: NewEndReport): boolean
  /**
   * Stores a progress note of a reply of a job in place of the job's notes
   * that are not delivered yet.
   *
   * @param note - The complete note.
   * @returns True when stored, after every other undelivered note of the job
   * is deleted, whichever of its replies sent it; false when the reply is not
   * a reply of that job, which changes nothing. Delivered notes, end reports,
   * and the notes of other jobs are kept.
   * @throws If the store is closed or the write fails, including when the
   * note's identity is already stored or its title or text is empty, each of
   * which breaks the precondition; the job's undelivered notes are then kept.
   */
  createProgressNote(note: NewProgressNote): boolean
}
