import type { ConversationSource, Job } from "@lys/share"
import { memo, type ReactElement } from "react"

import type { ReadonlyConversationMessage } from "@/lib/store/chat-view/conversation-transitions"

import type { JobCardPresentation } from "./job-presentation"
import LysMessage from "./LysMessage"
import UserMessage from "./UserMessage"

/** Properties accepted by {@link ChatMessage}. */
export type ChatMessageProps = {
  /** User message, or reply that is streaming or has ended. */
  readonly message: ReadonlyConversationMessage
  /** Name of the agent that answers the conversation. */
  readonly speakerName: string
  /**
   * Sources a reply may cite, in number order; see {@link LysMessage}. Empty
   * for a user message.
   */
  readonly sources: readonly ConversationSource[]
  /**
   * One-based position of a reply among the transcript's replies; 0 for a
   * user message.
   */
  readonly replyNumber: number
  /**
   * Cards of the jobs the message shows or names, in job order: for a reply,
   * those its tool calls sent a message; for a user message, those whose
   * reports it delivered. Empty when there are none.
   */
  readonly jobCards: readonly JobCardPresentation[]
  /**
   * Name of the agent that wrote the messages of the shown job, which labels
   * them; undefined in a main conversation.
   */
  readonly delegatorName: string | undefined
  /** Opens a job's conversation; receives the job's identity. */
  readonly onOpenJob: (jobId: string) => void
  /** Stops a job's latest reply; receives the job. */
  readonly onStopJob: (job: Job) => void
}

/**
 * Answers whether two lists hold the same items in the same order.
 *
 * @param previous - List of the earlier render.
 * @param next - List of the next render.
 * @returns True when both have the same length and the same object at every
 * position.
 */
function hasSameItems<Item>(
  previous: readonly Item[],
  next: readonly Item[]
): boolean {
  return (
    previous.length === next.length &&
    previous.every((item, index) => item === next[index])
  )
}

/**
 * Answers whether two renders of a {@link ChatMessage} would show the same
 * thing.
 *
 * @param previous - Properties of the earlier render.
 * @param next - Properties of the next render.
 * @returns True when the message object, the speaker's and the delegator's
 * names, the reply's position, and the open and stop callbacks are the same,
 * and the source and job card lists hold the same objects in the same order;
 * the transcript builds new lists for every render, so comparing the lists
 * themselves would always differ.
 */
function isSameChatMessage(
  previous: ChatMessageProps,
  next: ChatMessageProps
): boolean {
  const identityComparedProps = [
    "message",
    "speakerName",
    "delegatorName",
    "replyNumber",
    "onOpenJob",
    "onStopJob"
  ] as const
  return (
    identityComparedProps.every((name) => previous[name] === next[name]) &&
    hasSameItems(previous.sources, next.sources) &&
    hasSameItems(previous.jobCards, next.jobCards)
  )
}

/**
 * Selects role-specific presentation for one transcript message.
 *
 * @remarks The transcript keys every message, the streaming reply included,
 * by its identifier, so when a reply ends the same element updates in place:
 * its open disclosures stay open and focus inside it stays. Shared messages,
 * sources, and job cards are immutable; memoization skips body work while
 * {@link isSameChatMessage} holds, so a reply whose sources did not change
 * is not rendered again when another reply finds sources, and a message that
 * shows no job is not rendered again when a job changes.
 * @param props - The message, the names its replies and a job's messages
 * are shown under, the sources a reply may cite, a reply's position, and the
 * jobs the message shows or names with their open and stop callbacks.
 * @returns The rendered user message, streaming reply, or ended reply.
 */
function ChatMessage({
  message,
  speakerName,
  delegatorName,
  sources,
  replyNumber,
  jobCards,
  onOpenJob,
  onStopJob
}: ChatMessageProps): ReactElement {
  if (message.role === "user")
    return (
      <UserMessage
        delegatorName={delegatorName}
        jobCards={jobCards}
        message={message}
      />
    )
  if (message.status === "streaming")
    return (
      <LysMessage
        jobCards={jobCards}
        kind="streaming"
        message={message}
        onOpenJob={onOpenJob}
        onStopJob={onStopJob}
        replyNumber={replyNumber}
        sources={sources}
        speakerName={speakerName}
      />
    )
  return (
    <LysMessage
      jobCards={jobCards}
      kind="terminal"
      message={message}
      onOpenJob={onOpenJob}
      onStopJob={onStopJob}
      replyNumber={replyNumber}
      sources={sources}
      speakerName={speakerName}
    />
  )
}

export default memo(ChatMessage, isSameChatMessage)
