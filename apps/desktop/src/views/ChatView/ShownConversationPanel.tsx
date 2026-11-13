import type { ConversationSource, Job } from "@lys/share"
import {
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  type ReactElement,
  type RefObject
} from "react"

import ConversationPanel from "@/components/ChatViewComponents/ConversationPanel"
import {
  type ConversationActivity,
  createConversationPresentation
} from "@/components/ChatViewComponents/conversation-presentation"
import {
  createJobCardPresentations,
  type JobCardPresentation
} from "@/components/ChatViewComponents/job-presentation"
import { useAnsweringAgent } from "@/lib/hooks/answeringAgent"
import { useAgentStore } from "@/lib/store/agents"
import { formatConversationAgentName } from "@/lib/store/agents/conversation-agent"
import {
  type ChatRequestState,
  type ConversationOpenState,
  useChatViewStore
} from "@/lib/store/chat-view"
import type { ReadonlyConversationMessage } from "@/lib/store/chat-view/conversation-transitions"
import { useToolCallStore } from "@/lib/store/tool-calls"

/** Immutable empty transcript used before a conversation has started. */
const EMPTY_CONVERSATION_MESSAGES: readonly ReadonlyConversationMessage[] =
  Object.freeze([])

/** Immutable empty source list used before a conversation has started. */
const EMPTY_CONVERSATION_SOURCES: readonly ConversationSource[] = Object.freeze(
  []
)

/** Immutable empty job list used before a conversation has started. */
const EMPTY_CONVERSATION_JOBS: readonly Job[] = Object.freeze([])

/** Properties accepted by {@link ShownConversationPanel}. */
export type ShownConversationPanelProps = {
  /** Whether the parent-owned transcript remains pinned to latest content. */
  readonly atBottom: boolean
  /**
   * Receives native-scroll near-bottom results, and `true` when “Jump to
   * latest” is activated, before any scroll has completed.
   */
  readonly onScrollPositionChange: (atBottom: boolean) => void
  /** Opens a job's conversation; receives the job's identity. */
  readonly onOpenJob: (jobId: string) => void
}

/**
 * Determines what the conversation region is waiting on.
 *
 * @param request - Authoritative chat request lifecycle selected from the store.
 * @param conversationOpen - Authoritative stored-conversation open lifecycle.
 * @returns Opening while a stored conversation is read, generating while a
 * reply is awaited or streamed, and idle otherwise.
 */
function calculateConversationActivity(
  request: ChatRequestState,
  conversationOpen: ConversationOpenState
): ConversationActivity {
  if (conversationOpen.status === "opening") return "opening-conversation"

  switch (request.status) {
    case "idle":
    case "reply-completed":
      return "idle"
    case "awaiting-turn":
    case "reply-streaming":
      return "generating-reply"
  }
}

/** The transcript host and the handlers that keep its position. */
type TranscriptPosition = Readonly<{
  /** Host the transcript scrolls in, for the panel to attach. */
  transcriptRef: RefObject<HTMLDivElement | null>
  /** Records whether the reader remains near the bottom of the transcript. */
  handleTranscriptScroll: () => void
  /** Scrolls the transcript to its latest content and restores pinned state. */
  handleJumpToLatest: () => void
}>

/**
 * Keeps the transcript's scroll position in step with the parent's pinned
 * state.
 *
 * @param atBottom - Whether the parent says the transcript is pinned to its
 * latest content; read reactively.
 * @param messages - The shown transcript; read reactively.
 * @param onScrollPositionChange - Receives the reader's position after a
 * scroll, and `true` when the reader jumps to the latest content.
 * @returns The transcript host for the panel to attach and the handlers of
 * its scrolling and its jump control.
 * @remarks While pinned, the host scrolls to its latest content whenever the
 * transcript changes, once the host is attached and messages exist. A scroll
 * leaving less than 120px below counts as near the bottom.
 */
function useTranscriptPosition(
  atBottom: boolean,
  messages: readonly ReadonlyConversationMessage[],
  onScrollPositionChange: (atBottom: boolean) => void
): TranscriptPosition {
  const transcriptRef = useRef<HTMLDivElement>(null)

  /**
   * Handles a change of the transcript or of its pinned state, by scrolling
   * a pinned transcript that has messages to its latest content.
   *
   * @param isPinned - Whether the transcript is pinned to its latest content.
   * @param messageCount - Number of messages the transcript shows.
   */
  function handleTranscriptChange(
    isPinned: boolean,
    messageCount: number
  ): void {
    const element = transcriptRef.current
    if (!element || !isPinned || messageCount === 0) return

    element.scrollTo?.({ top: element.scrollHeight })
  }
  const handleShownTranscriptChange = useEffectEvent(handleTranscriptChange)

  useEffect(() => {
    handleShownTranscriptChange(atBottom, messages.length)
  }, [atBottom, messages])

  /** Records whether the reader remains near the bottom of the transcript. */
  function handleTranscriptScroll(): void {
    const element = transcriptRef.current
    if (!element) return

    const nearBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight < 120
    onScrollPositionChange(nearBottom)
  }

  /** Scrolls the transcript to its latest content and restores pinned state. */
  function handleJumpToLatest(): void {
    const element = transcriptRef.current
    if (!element) return

    element.scrollTo?.({ top: element.scrollHeight, behavior: "smooth" })
    onScrollPositionChange(true)
  }

  return { transcriptRef, handleTranscriptScroll, handleJumpToLatest }
}

/**
 * Builds the cards of the shown conversation's jobs.
 *
 * @param jobs - Jobs of the shown conversation, in number order; read
 * reactively.
 * @returns The cards, with each job's agent named from the agent list and
 * its state from the calls the tool-call store holds. The list and its cards
 * keep their identities until the jobs, the held calls, or the agent list
 * change, which spares the transcript's messages renders; nothing relies on
 * that for correctness.
 */
function useJobCards(jobs: readonly Job[]): readonly JobCardPresentation[] {
  const heldCalls = useToolCallStore((state) => state.heldCalls)
  const agentList = useAgentStore((state) => state.list)

  return useMemo(
    () => createJobCardPresentations(jobs, heldCalls, agentList),
    [jobs, heldCalls, agentList]
  )
}

/**
 * Presents the shown conversation: its transcript, the cards of its jobs,
 * its pending work, and its position.
 *
 * @remarks The chat-view store owns the shown conversation, its request and
 * open state, sending a starter prompt, and stopping a job; the tool-call
 * store owns the calls that wait for the person, which mark a working job as
 * needing approval; the agent store owns the agent list that names the
 * agents. The parent owns whether the transcript is pinned and what opening
 * a job does. The component owns the transcript host: it keeps the latest
 * content in view while pinned and messages exist, reports the reader's
 * position as they scroll, and pins the transcript when the reader jumps to
 * the latest content. Stopping a job is asked of the store, which records a
 * failed stop as the view's error. An empty conversation renders the
 * starter view.
 * @param props - Parent-owned transcript position, its change notification,
 * and the opening of a job.
 * @returns The conversation landmark.
 */
export default function ShownConversationPanel(
  props: ShownConversationPanelProps
): ReactElement {
  const { atBottom, onOpenJob, onScrollPositionChange } = props
  const conversation = useChatViewStore((state) => state.conversation)
  const conversationOpen = useChatViewStore((state) => state.conversationOpen)
  const error = useChatViewStore((state) => state.error)
  const request = useChatViewStore((state) => state.request)
  const sendMessage = useChatViewStore((state) => state.sendMessage)
  const stopJob = useChatViewStore((state) => state.stopJob)
  const agentName = formatConversationAgentName(useAnsweringAgent())
  const messages = conversation?.messages ?? EMPTY_CONVERSATION_MESSAGES
  const jobCards = useJobCards(conversation?.jobs ?? EMPTY_CONVERSATION_JOBS)
  const { transcriptRef, handleTranscriptScroll, handleJumpToLatest } =
    useTranscriptPosition(atBottom, messages, onScrollPositionChange)

  return (
    <ConversationPanel
      {...createConversationPresentation(messages)}
      activity={calculateConversationActivity(request, conversationOpen)}
      agentName={agentName}
      error={error}
      isAtBottom={atBottom}
      jobCards={jobCards}
      onJumpToLatest={handleJumpToLatest}
      onOpenJob={onOpenJob}
      onSendMessage={sendMessage}
      onStopJob={stopJob}
      onTranscriptScroll={handleTranscriptScroll}
      sources={conversation?.sources ?? EMPTY_CONVERSATION_SOURCES}
      transcriptRef={transcriptRef}
    />
  )
}
