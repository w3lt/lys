import type { Job, JobReportKind, JobState } from "@lys/share"

import type { AgentListState } from "@/lib/store/agents"
import {
  findConversationAgent,
  formatConversationAgentName
} from "@/lib/store/agents/conversation-agent"
import type { ReadonlyConversationMessage } from "@/lib/store/chat-view/conversation-transitions"
import {
  isToolCallPart,
  type ChatViewReplyPart
} from "@/lib/store/chat-view/reply-parts"
import {
  isReplyAwaitingApproval,
  type HeldToolCall
} from "@/lib/store/tool-calls"

/**
 * State a job's card shows: the job's own state, or `needs-approval` while
 * the job works and its reply waits for the person to allow or reject a call.
 */
export type JobCardState = JobState | "needs-approval"

/** What the card of one job of the shown conversation shows. */
export type JobCardPresentation = Readonly<{
  /** The job, as the conversation lists it. */
  job: Job
  /**
   * Name of the agent that works on the job; its code once the agent is
   * deleted or while the agent list is unread.
   */
  agentName: string
  /** State the card shows. */
  state: JobCardState
}>

/** The jobs one reply shows, each once. */
export type ReplyJobsPresentation = Readonly<{
  /** Cards of the jobs the reply started, in job order. */
  started: readonly JobCardPresentation[]
  /**
   * Cards of the jobs the reply sent a later message without starting them,
   * in job order.
   */
  continued: readonly JobCardPresentation[]
}>

/**
 * Calculates the state a job's card shows.
 *
 * @param job - The job, as the conversation lists it.
 * @param heldCalls - Calls the tool-call store holds.
 * @returns `needs-approval` while the job works and its latest reply waits
 * for the person; otherwise the job's own state.
 */
function calculateJobCardState(
  job: Job,
  heldCalls: readonly HeldToolCall[]
): JobCardState {
  const isAwaitingPerson =
    job.state === "working" && isReplyAwaitingApproval(heldCalls, job.replyId)
  return isAwaitingPerson ? "needs-approval" : job.state
}

/**
 * Creates the card of one job.
 *
 * @param job - The job, as the conversation lists it.
 * @param heldCalls - Calls the tool-call store holds.
 * @param agentList - Agent list as last read.
 * @returns A frozen card.
 */
function createJobCardPresentation(
  job: Job,
  heldCalls: readonly HeldToolCall[],
  agentList: AgentListState
): JobCardPresentation {
  const agent = findConversationAgent(agentList, job.agentCode)
  return Object.freeze({
    job,
    agentName: formatConversationAgentName(agent),
    state: calculateJobCardState(job, heldCalls)
  })
}

/**
 * Creates the cards of a conversation's jobs.
 *
 * @param jobs - Jobs of the shown conversation, in number order.
 * @param heldCalls - Calls the tool-call store holds.
 * @param agentList - Agent list as last read.
 * @returns One frozen card per job, in the jobs' order, in a frozen list.
 */
export function createJobCardPresentations(
  jobs: readonly Job[],
  heldCalls: readonly HeldToolCall[],
  agentList: AgentListState
): readonly JobCardPresentation[] {
  return Object.freeze(
    jobs.map((job) => createJobCardPresentation(job, heldCalls, agentList))
  )
}

/**
 * Lists the identities of a reply's tool calls.
 *
 * @param parts - The reply's parts, as the chat view holds them.
 * @returns The identity of every tool call among the parts.
 */
function listToolCallIds(
  parts: readonly ChatViewReplyPart[]
): ReadonlySet<string> {
  return new Set(parts.filter(isToolCallPart).map((part) => part.id))
}

/**
 * Lists the cards one message of the transcript shows or names.
 *
 * @param message - Message of the shown conversation.
 * @param jobCards - Cards of every job of the conversation.
 * @returns For a reply, the cards of the jobs any of whose `jobCallIds` is
 * one of its tool calls; for a user message, the cards of the jobs its
 * reports came from; in the cards' order, in a frozen list. The given list
 * itself when it is empty.
 */
export function listMessageJobCards(
  message: ReadonlyConversationMessage,
  jobCards: readonly JobCardPresentation[]
): readonly JobCardPresentation[] {
  if (jobCards.length === 0) return jobCards
  if (message.role === "user") {
    const reportJobIds = new Set(message.reports.map((report) => report.jobId))
    return Object.freeze(
      jobCards.filter((card) => reportJobIds.has(card.job.id))
    )
  }

  const callIds = listToolCallIds(message.parts)
  return Object.freeze(
    jobCards.filter((card) => card.job.jobCallIds.some((id) => callIds.has(id)))
  )
}

/**
 * Creates the jobs one reply shows.
 *
 * @param parts - The reply's parts, as the chat view holds them.
 * @param jobCards - Cards of the jobs to look for, such as those
 * {@link listMessageJobCards} lists for the reply.
 * @returns As started, the cards whose first `jobCallIds` entry is one of
 * the reply's tool calls; as continued, the others with a later entry among
 * them. A reply that started a job and then sent it another message shows
 * the job once, as started.
 */
export function createReplyJobsPresentation(
  parts: readonly ChatViewReplyPart[],
  jobCards: readonly JobCardPresentation[]
): ReplyJobsPresentation {
  const callIds = listToolCallIds(parts)
  const started = jobCards.filter((card) => callIds.has(card.job.jobCallIds[0]))
  const continued = jobCards.filter(
    (card) =>
      !started.includes(card) &&
      card.job.jobCallIds.some((id) => callIds.has(id))
  )
  return Object.freeze({
    started: Object.freeze(started),
    continued: Object.freeze(continued)
  })
}

/**
 * Formats the state a job's card shows.
 *
 * @param state - State of the card.
 * @returns A short label.
 */
export function formatJobCardState(state: JobCardState): string {
  switch (state) {
    case "working":
      return "Working"
    case "needs-approval":
      return "Needs your approval"
    case "replied":
      return "Replied"
    case "stopped":
      return "Stopped"
    case "failed":
      return "Failed"
    case "interrupted":
      return "Interrupted"
  }
}

/**
 * Formats the element identifier of a job's card, which a link to the card
 * names as its fragment.
 *
 * @param jobId - The job's identity.
 * @returns Such as `job-<jobId>`.
 */
export function formatJobElementId(jobId: string): string {
  return `job-${jobId}`
}

/**
 * Answers whether a job's card offers Stop.
 *
 * @param state - State of the card.
 * @returns True while the job works, whether or not it waits for the person.
 */
export function canStopJob(state: JobCardState): boolean {
  switch (state) {
    case "working":
    case "needs-approval":
      return true
    case "replied":
    case "stopped":
    case "failed":
    case "interrupted":
      return false
  }
}

/**
 * Formats what a delivered report says.
 *
 * @param kind - Kind of the report.
 * @returns A short label, such as `Progress note` for a note.
 */
export function formatJobReportKind(kind: JobReportKind): string {
  switch (kind) {
    case "note":
      return "Progress note"
    case "result":
      return "Result"
    case "failed":
      return "Failed"
    case "stopped":
      return "Stopped"
    case "interrupted":
      return "Interrupted"
  }
}

/**
 * Formats the line under a person's message that delivered reports.
 *
 * @param reportCount - Number of reports the message delivered, from 1.
 * @returns Such as `1 report delivered with this message` or
 * `2 reports delivered with this message`.
 */
export function formatDeliveredReportsLabel(reportCount: number): string {
  const noun = reportCount === 1 ? "report" : "reports"
  return `${reportCount} ${noun} delivered with this message`
}

/**
 * Formats the accessible name of one of a user message's controls, such as
 * the line that opens to the reports it delivered.
 *
 * @param label - The control's visible text.
 * @param messageNumber - One-based position of the message among the
 * transcript's user messages: the person's, a delegator's, and wake-up
 * messages.
 * @returns The visible text, then the message, such as `Reports · 1,
 * message 3`, so the same control of different messages has different names.
 */
export function formatMessageControlName(
  label: string,
  messageNumber: number
): string {
  return `${label}, message ${messageNumber}`
}
