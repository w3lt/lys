import { v7 as uuidv7 } from "uuid"
import {
  conversationMetadataSchema,
  conversationUserMessageSchema,
  conversationAssistantMessageSchema,
  type Conversation,
  type ConversationAssistantMessage,
  type ConversationSource,
  type ConversationUserMessage,
  type JobReport
} from "@lys/share"
import type {
  ConversationTurn,
  ConversationTurnAuthor,
  ConversationTurnTarget,
  ConversationTurnUserMessage,
  CreateConversationTurnOptions
} from "../chat/persistence"
import { ConversationNotFoundError } from "../../utils/errors"
import { buildRenumberedCitations, listCitedNumbers } from "./citationNumbers"
import type {
  ConversationTurnRecords,
  ConversationTurnTransaction,
  JobReportDelivery,
  JobTurnTransaction
} from "./records"

/** Target of a turn that continues a stored conversation or a stored job. */
type ContinuedConversationTarget = Extract<
  ConversationTurnTarget,
  { kind: "existing" | "existing-job" }
>

/** The records a continued conversation is changed and read through. */
type ContinuedConversationRecords = Readonly<{
  /** Interruption of the conversation's streaming replies, and its read. */
  turn: Pick<
    ConversationTurnTransaction,
    "updateStreamingAssistantMessagesToInterrupted" | "findConversation"
  >
  /** The new title of a continued job. */
  jobs: Pick<JobTurnTransaction, "updateJobTitle">
}>

/**
 * The records the reports that wait for a turn's conversation are delivered
 * through.
 */
type JobReportDeliveryRecords = Readonly<{
  /** Reads of the jobs whose reports are delivered. */
  turn: Pick<ConversationTurnTransaction, "findConversation">
  /** The reports that wait, their delivery, and the sources they add. */
  jobs: Pick<
    JobTurnTransaction,
    | "listUndeliveredJobReports"
    | "updateJobReportToDelivered"
    | "createConversationSource"
  >
}>

/** One report as its delegator reads it, and the sources it adds there. */
type RenumberedJobReport = Readonly<{
  /**
   * The report with each marker that cites a source of its job carrying the
   * delegator's number for that source, and those numbers, ascending.
   */
  report: JobReport
  /**
   * The sources it cites whose URL the delegator has no source for, numbered
   * after the delegator's highest number in the order of the job's numbers.
   */
  addedSources: readonly ConversationSource[]
}>

/** The reports a turn delivered, and its conversation's sources after them. */
type DeliveredJobReports = Readonly<{
  /** The delivered reports, oldest first, as the delegator reads them. */
  reports: readonly JobReport[]
  /**
   * Every source of the conversation once the reports are delivered, in
   * number order: the ones it had, then the ones the reports added.
   */
  sources: readonly ConversationSource[]
}>

/**
 * What a turn fails with when its message's author and its conversation do
 * not fit.
 */
const JOB_MESSAGE_AUTHOR_MESSAGE =
  "A job message is written by a delegator, and only into a job"

/**
 * Finds the `delegate_work` call that sends the message of a turn.
 * @param target - Conversation the turn starts or continues.
 * @param author - Who writes the turn's user message.
 * @returns The call's UUIDv7 for a job message, which a delegator writes
 * into a job; undefined for any other message.
 * @throws If the turn starts or continues a job and its author is not a
 * delegator, or a delegator writes the message of any other turn.
 */
function findJobCallId(
  target: ConversationTurnTarget,
  author: ConversationTurnAuthor
): string | undefined {
  const isJobTarget =
    target.kind === "new-job" || target.kind === "existing-job"
  if (isJobTarget !== (author.origin === "delegator"))
    throw new Error(JOB_MESSAGE_AUTHOR_MESSAGE)
  return author.origin === "delegator" ? author.jobCallId : undefined
}

/**
 * Creates a new empty, untitled main conversation answered by one agent.
 * @param transaction - Conversation creation lent by the turn's write
 * transaction.
 * @param target - Identity of the new conversation and the code of the agent
 * that answers it.
 * @param now - Creation time, also its initial activity time.
 * @returns The newly stored independent conversation snapshot, with no
 * parent, job number, delegator, or jobs.
 * @throws If validation fails, the transaction has ended, or the write fails.
 */
function createMainConversation(
  transaction: Pick<ConversationTurnTransaction, "createConversation">,
  target: Extract<ConversationTurnTarget, { kind: "new" }>,
  now: string
): Conversation {
  const metadata = conversationMetadataSchema.parse({
    id: target.id,
    title: null,
    agentCode: target.agentCode,
    parentConversationId: null,
    jobNumber: null,
    delegatorAgentCode: null,
    createdAt: now,
    updatedAt: now
  })
  transaction.createConversation(metadata)
  return { ...metadata, messages: [], sources: [], jobs: [] }
}

/**
 * Calculates the number the next job of a conversation gets.
 * @param parent - Snapshot of the conversation the job is started from.
 * @returns One more than the highest number its jobs have; 1 when it has
 * none.
 */
function calculateNextJobNumber(parent: Conversation): number {
  let highestNumber = 0
  for (const job of parent.jobs)
    highestNumber = Math.max(highestNumber, job.number)
  return highestNumber + 1
}

/**
 * Creates a new empty job started from a stored conversation.
 * @param transaction - Conversation reading and creation lent by the turn's
 * write transaction.
 * @param target - Identity of the new job, the code of the agent that works
 * on it, its parent, and its title.
 * @param now - Creation time, also its initial activity time.
 * @returns The newly stored independent job snapshot: numbered one above the
 * highest number its parent's jobs have, with its parent's agent as the
 * delegator, and without messages, sources, or jobs.
 * @throws ConversationNotFoundError if the parent is not stored.
 * @throws If validation fails, the transaction has ended, a stored value
 * violates the conversation contract, or the write fails.
 * @remarks The parent is read before the job is stored. A stored job without
 * a job message and a reply breaks the job contract, so the parent cannot be
 * read again until the turn has stored both.
 */
function createJob(
  transaction: Pick<
    ConversationTurnTransaction,
    "createConversation" | "findConversation"
  >,
  target: Extract<ConversationTurnTarget, { kind: "new-job" }>,
  now: string
): Conversation {
  const parent = transaction.findConversation(target.parentConversationId)
  if (parent === undefined) throw new ConversationNotFoundError()
  const metadata = conversationMetadataSchema.parse({
    id: target.id,
    title: target.title,
    agentCode: target.agentCode,
    parentConversationId: parent.id,
    jobNumber: calculateNextJobNumber(parent),
    delegatorAgentCode: parent.agentCode,
    createdAt: now,
    updatedAt: now
  })
  transaction.createConversation(metadata)
  return { ...metadata, messages: [], sources: [], jobs: [] }
}

/**
 * Stores what a turn changes about the conversation it continues, then reads
 * that conversation.
 * @param records - Records lent by the turn's write transaction.
 * @param target - The continued conversation, with the title of the job
 * message when it is a job.
 * @param now - Time of the turn, stored on each reply it interrupts.
 * @returns The conversation's snapshot before the turn's messages: each of
 * its replies that was streaming is interrupted, and a continued job has the
 * title of the job message.
 * @throws ConversationNotFoundError if the conversation is not stored.
 * @throws If a job message continues a conversation that is not a job. Its
 * streaming replies are interrupted by then, which the caller's transaction
 * rolls back.
 * @throws If the transaction has ended, a stored value violates the
 * conversation contract, or a write fails.
 */
function updateContinuedConversation(
  records: ContinuedConversationRecords,
  target: ContinuedConversationTarget,
  now: string
): Conversation {
  const isJobTarget = target.kind === "existing-job"
  if (isJobTarget) records.jobs.updateJobTitle(target.id, target.title)
  records.turn.updateStreamingAssistantMessagesToInterrupted(target.id, now)
  const conversation = records.turn.findConversation(target.id)
  if (conversation === undefined) throw new ConversationNotFoundError()
  if (isJobTarget && conversation.parentConversationId === null)
    throw new Error(JOB_MESSAGE_AUTHOR_MESSAGE)
  return conversation
}

/**
 * Stores the conversation a turn starts, or what the turn changes about the
 * one it continues.
 * @param records - Records lent by the turn's write transaction.
 * @param target - Conversation the turn starts or continues.
 * @param now - Time of the turn.
 * @returns The conversation's snapshot before the turn's messages.
 * @throws ConversationNotFoundError if the continued conversation, or the
 * parent of a new job, is not stored.
 * @throws If a job message continues a conversation that is not a job,
 * validation fails, the transaction has ended, a stored value violates the
 * conversation contract, or a write fails.
 */
function saveTurnConversation(
  records: ConversationTurnRecords,
  target: ConversationTurnTarget,
  now: string
): Conversation {
  switch (target.kind) {
    case "new":
      return createMainConversation(records.turn, target, now)
    case "new-job":
      return createJob(records.turn, target, now)
    case "existing":
    case "existing-job":
      return updateContinuedConversation(records, target, now)
  }
}

/**
 * Calculates the number the next attachment of a conversation gets.
 * @param conversation - Snapshot of the conversation before the turn.
 * @returns One more than the highest number its attachments have; 1 when it
 * has none.
 */
function calculateNextAttachmentNumber(conversation: Conversation): number {
  let highestNumber = 0
  for (const message of conversation.messages) {
    if (message.role !== "user") continue
    for (const attachment of message.attachments)
      highestNumber = Math.max(highestNumber, attachment.number)
  }
  return highestNumber + 1
}

/**
 * Builds the validated user message of a turn with provisional attachment
 * numbers.
 * @param userMessage - Identity, content, author, and attachment drafts.
 * @param now - Time of the turn.
 * @returns The message with its author's origin, without reports, and with
 * its attachments numbered from 1 in message order, for
 * {@link buildNumberedUserMessage} once the conversation's highest number is
 * known.
 * @throws If the message or an attachment violates the conversation contract.
 */
function buildUserMessage(
  userMessage: ConversationTurnUserMessage,
  now: string
): ConversationUserMessage {
  return conversationUserMessageSchema.parse({
    id: userMessage.id,
    role: "user",
    content: userMessage.content,
    attachments: userMessage.attachments.map((draft, index) => ({
      ...draft,
      number: index + 1
    })),
    origin: userMessage.author.origin,
    reports: [],
    createdAt: now
  })
}

/**
 * Builds a validated message with its attachments numbered after the
 * conversation's.
 * @param userMessage - Validated message whose attachments are numbered
 * from 1.
 * @param conversation - Snapshot of the conversation before the turn.
 * @returns The message with each attachment's number raised by the
 * conversation's highest attachment number, so the message continues the
 * conversation's numbering in message order; the message itself when it has
 * no attachments.
 */
function buildNumberedUserMessage(
  userMessage: ConversationUserMessage,
  conversation: Conversation
): ConversationUserMessage {
  if (userMessage.attachments.length === 0) return userMessage
  const offset = calculateNextAttachmentNumber(conversation) - 1
  return {
    ...userMessage,
    attachments: userMessage.attachments.map((attachment) => ({
      ...attachment,
      number: attachment.number + offset
    }))
  }
}

/**
 * Builds the validated reply a turn starts.
 * @param model - Nonempty model identity stored on the reply.
 * @param now - Time of the turn.
 * @returns A streaming reply without parts, under a new UUIDv7.
 * @throws If the reply violates the conversation contract, as one with an
 * empty model does.
 */
function buildStreamingReply(
  model: string,
  now: string
): ConversationAssistantMessage {
  return conversationAssistantMessageSchema.parse({
    id: uuidv7(),
    role: "assistant",
    model,
    parts: [],
    status: "streaming",
    finishReason: null,
    createdAt: now,
    updatedAt: now
  })
}

/**
 * Calculates the number the next source of a conversation gets.
 * @param sources - The conversation's sources.
 * @returns One more than the highest number they have; 1 when there are
 * none.
 */
function calculateNextSourceNumber(
  sources: readonly ConversationSource[]
): number {
  let highestNumber = 0
  for (const source of sources)
    highestNumber = Math.max(highestNumber, source.number)
  return highestNumber + 1
}

/**
 * Lists the sources of the job a report is from.
 * @param turn - Conversation reads lent by the turn's write transaction.
 * @param jobId - UUIDv7 of the job: its conversation.
 * @returns The job's sources, in number order.
 * @throws If the job is not stored, which the job of a stored report always
 * is, the transaction has ended, or a stored value violates the
 * conversation contract.
 */
function listJobSources(
  turn: Pick<ConversationTurnTransaction, "findConversation">,
  jobId: string
): readonly ConversationSource[] {
  const job = turn.findConversation(jobId)
  if (job === undefined) throw new Error("A report's job is not stored")
  return job.sources
}

/**
 * Builds a report as its delegator reads it, with the sources it adds to the
 * delegator's conversation.
 * @param report - Undelivered report, whose markers carry its job's numbers.
 * @param jobSources - Sources of the report's job, in number order.
 * @param delegatorSources - Sources of the delegator's conversation so far,
 * in number order, the ones earlier reports of the delivery added included.
 * @returns The report with each marker whose number is a source of its job
 * rewritten to the delegator's number for that source's URL, and with the
 * delegator's numbers it cites; every other marker is kept. Each cited
 * source whose URL the delegator has no source for is among the added
 * sources, with the job's title for it, numbered on from the delegator's
 * highest number in the order of the job's numbers. A `stopped` or
 * `interrupted` report has no text, so it cites none and adds none.
 */
function buildRenumberedJobReport(
  report: JobReport,
  jobSources: readonly ConversationSource[],
  delegatorSources: readonly ConversationSource[]
): RenumberedJobReport {
  if (report.kind === "stopped" || report.kind === "interrupted")
    return { report: { ...report, sourceNumbers: [] }, addedSources: [] }
  const citedNumbers = new Set(listCitedNumbers(report.content))
  const sourcesByUrl = new Map(
    delegatorSources.map((source) => [source.url, source])
  )
  const firstAddedNumber = calculateNextSourceNumber(delegatorSources)
  const numbers = new Map<number, number>()
  const addedSources: ConversationSource[] = []
  for (const jobSource of jobSources) {
    if (!citedNumbers.has(jobSource.number)) continue
    let source = sourcesByUrl.get(jobSource.url)
    if (source === undefined) {
      source = {
        number: firstAddedNumber + addedSources.length,
        url: jobSource.url,
        title: jobSource.title
      }
      addedSources.push(source)
    }
    numbers.set(jobSource.number, source.number)
  }
  const renumbered = buildRenumberedCitations(report.content, numbers)
  const renumberedReport: JobReport = {
    ...report,
    content: renumbered.text,
    sourceNumbers: renumbered.citedNumbers
  }
  return { report: renumberedReport, addedSources }
}

/**
 * Builds the delivery of a report as its delegator reads it.
 * @param report - The report, renumbered into its delegator's conversation.
 * @param messageId - Stored user message that delivers it.
 * @returns The delivery that stores the report's text and source numbers
 * with the message.
 */
function buildJobReportDelivery(
  report: JobReport,
  messageId: string
): JobReportDelivery {
  return {
    reportId: report.id,
    messageId,
    content: report.content,
    sourceNumbers: report.sourceNumbers
  }
}

/**
 * Marks the reports that wait for a conversation as delivered with one of
 * its user messages, each as the conversation's agent reads it.
 * @param records - Records lent by the turn's write transaction.
 * @param conversation - Snapshot of the conversation whose jobs sent the
 * reports, read in this transaction.
 * @param messageId - Stored user message of that conversation.
 * @returns The delivered reports, oldest first: every report of the
 * conversation's jobs that was not delivered yet, of any kind, as
 * {@link buildRenumberedJobReport} builds it; and the conversation's sources
 * with the ones the reports added. No report and no new source when no
 * report waits.
 * @throws If a report's job is not stored, the transaction has ended, a
 * stored value violates the conversation or report contract, or a write
 * fails.
 * @remarks Each job is read once, however many of its reports wait. The
 * sources a report adds are stored before it is marked delivered, and a
 * later report of the delivery finds them by URL like the stored ones.
 */
function updateJobReportsToDelivered(
  records: JobReportDeliveryRecords,
  conversation: Conversation,
  messageId: string
): DeliveredJobReports {
  const waitingReports = records.jobs.listUndeliveredJobReports(conversation.id)
  const jobSourcesById = new Map<string, readonly ConversationSource[]>()
  const reports: JobReport[] = []
  let sources = conversation.sources
  for (const report of waitingReports) {
    const jobSources =
      jobSourcesById.get(report.jobId) ??
      listJobSources(records.turn, report.jobId)
    jobSourcesById.set(report.jobId, jobSources)
    const renumbered = buildRenumberedJobReport(report, jobSources, sources)
    for (const source of renumbered.addedSources)
      records.jobs.createConversationSource(conversation.id, source)
    records.jobs.updateJobReportToDelivered(
      buildJobReportDelivery(renumbered.report, messageId)
    )
    reports.push(renumbered.report)
    sources = [...sources, ...renumbered.addedSources]
  }
  return { reports, sources }
}

/**
 * Stores a validated user/assistant pair inside the caller-owned transaction,
 * with the conversation or the job the turn starts, and delivers the reports
 * that wait for the conversation.
 * @param records - Records lent to the caller's write transaction.
 * @param options - Conversation selection, the user message with its
 * identity, author, and attachment drafts, and the model. A new conversation
 * stores the identity and the agent code it names; an existing conversation
 * keeps its agent. A new job also stores its parent, its title, and the
 * number after its parent's highest; a continued job gets the title of the
 * job message.
 * @param now - Time of the turn, read once by the caller. Every value the turn
 * builds carries it: a new conversation's times, both messages' times, and
 * the update time of each reply the turn interrupts.
 * @returns The conversation snapshot, with the sources the delivered reports
 * added, and both messages written to the transaction; the user message
 * carries its author's origin, its attachments, numbered after the
 * conversation's highest attachment number in message order, and the
 * reports the turn delivered with it, as the conversation's agent reads
 * them.
 * @throws If the turn starts or continues a job and its message is not a
 * delegator's, or a delegator's message starts or continues a main
 * conversation; nothing is stored by then.
 * @throws ConversationNotFoundError if the continued conversation, or the
 * parent of a new job, is not stored.
 * @throws If a job message continues a conversation that is not a job,
 * validation fails, the transaction has ended, a stored value violates the
 * conversation or report contract, a delivered report's job is not stored,
 * or storage rejects a write.
 * @remarks Both messages are validated before the first write; the user
 * message's attachments get their final numbers once the snapshot is read.
 * A reply still streaming in an existing conversation becomes interrupted
 * before the snapshot is read, so the new turn supersedes it. A stopped
 * request can finalize its reply after the client has already sent the next
 * turn. Interrupting it here keeps its stored text and answered calls in the
 * new turn's context, and the streaming-only write guards then reject every
 * later write from the superseded generation.
 * Every report of the conversation's jobs that is not delivered yet is
 * marked delivered with the user message once that message is stored, oldest
 * first, so a report reaches its delegator once, with the next turn of the
 * conversation, whoever starts it. Each source of its job that a report
 * cites is found by URL among the conversation's sources, or stored there
 * under the next number, and the report's markers are rewritten to the
 * conversation's numbers, so the delegator's citations open the pages the
 * job read.
 */
export function createConversationTurn(
  records: ConversationTurnRecords,
  options: CreateConversationTurnOptions,
  now: string
): ConversationTurn {
  const target = options.conversation
  const jobCallId = findJobCallId(target, options.userMessage.author)
  const draftUserMessage = buildUserMessage(options.userMessage, now)
  const assistantMessage = buildStreamingReply(options.model, now)
  const conversation = saveTurnConversation(records, target, now)
  const storedUserMessage = buildNumberedUserMessage(
    draftUserMessage,
    conversation
  )
  records.turn.createUserMessage(conversation.id, storedUserMessage, jobCallId)
  const delivered = updateJobReportsToDelivered(
    records,
    conversation,
    storedUserMessage.id
  )
  records.turn.createAssistantMessage(conversation.id, assistantMessage)
  const userMessage: ConversationUserMessage = {
    ...storedUserMessage,
    reports: delivered.reports
  }
  const turnConversation: Conversation = {
    ...conversation,
    sources: delivered.sources
  }
  return {
    conversation: turnConversation,
    userMessage,
    assistantMessage,
    isNewConversation: target.kind === "new" || target.kind === "new-job"
  }
}
