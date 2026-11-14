import {
  jobReportSchema,
  type ConversationAssistantMessage,
  type ConversationAttachment,
  type ConversationMessage,
  type ConversationSource,
  type ConversationUserMessage,
  type JobReport,
  type JobReportKind,
  type ReplyPart,
  type ToolCallReplyPart
} from "@lys/share"
import { v7 as uuidv7 } from "uuid"
import type {
  ConversationTurn,
  ConversationTurnTarget,
  ConversationTurnUserMessage
} from "../../../src/modules/chat/persistence"

/**
 * Creates a syntactically valid UUIDv7 whose last group encodes `sequence`.
 *
 * @param sequence - Non-negative integer below 2^48; larger values sort later
 * when the timestamp groups are equal.
 * @returns A lowercase UUIDv7 string.
 */
export function createFixtureUuidV7(sequence: number): string {
  return `01900000-0000-7000-8000-${sequence.toString(16).padStart(12, "0")}`
}

/** Conversation identity used by turn fixtures. */
export const FIXTURE_CONVERSATION_ID = createFixtureUuidV7(1)

/** Timestamp shared by turn fixtures. */
export const FIXTURE_TIMESTAMP = "2026-01-02T03:04:05.678Z"

/**
 * Creates a stored user message the person wrote.
 *
 * @param sequence - Identity sequence of the message.
 * @param content - Non-empty authored text.
 * @param attachments - Stored attachments in number order; none when omitted.
 * @returns A valid user message of the person that delivers no reports.
 */
export function createUserMessage(
  sequence: number,
  content: string,
  attachments: readonly ConversationAttachment[] = []
): ConversationUserMessage & Readonly<{ origin: "person" }> {
  return {
    id: createFixtureUuidV7(sequence),
    role: "user",
    content,
    attachments,
    origin: "person",
    reports: [],
    createdAt: FIXTURE_TIMESTAMP
  }
}

/** Values that distinguish one delivered report fixture from another. */
export type DeliveredReportFixture = Readonly<{
  /** Identity sequence of the report. */
  sequence: number
  /** Number of the job that sent the report, from 1. */
  jobNumber: number
  /** Code of the agent that works on the job. */
  agentCode: string
  /** Title of the job message the report answers. */
  title: string
  /** What the report says. */
  kind: JobReportKind
  /** Text of the report; empty for a stopped or an interrupted report. */
  content: string
}>

/**
 * Creates a report as a user-role message of the job's parent conversation
 * delivers it.
 *
 * @param fixture - Identity, job, agent, title, kind, and text of the report.
 * @returns A report written at the fixture time that cites no source,
 * validated by the shared schema. Its job's conversation identity follows
 * from the job number, so reports of one job name the same job.
 * @throws If the fixture's kind does not allow its text.
 */
export function createDeliveredReport(
  fixture: DeliveredReportFixture
): JobReport {
  /**
   * Identity sequence the jobs of report fixtures count from: job `n` of a
   * report fixture has the sequence `9000 + n`.
   */
  const reportJobSequenceBase = 9000

  return jobReportSchema.parse({
    id: createFixtureUuidV7(fixture.sequence),
    jobId: createFixtureUuidV7(reportJobSequenceBase + fixture.jobNumber),
    jobNumber: fixture.jobNumber,
    agentCode: fixture.agentCode,
    title: fixture.title,
    kind: fixture.kind,
    content: fixture.content,
    sourceNumbers: [],
    createdAt: FIXTURE_TIMESTAMP
  })
}

/**
 * Creates the target of a turn that starts a new conversation.
 *
 * @param agentCode - Code of the agent that answers it.
 * @returns The target with a fresh UUIDv7, as the chat route makes one.
 */
export function createNewConversationTarget(
  agentCode: string
): Extract<ConversationTurnTarget, { kind: "new" }> {
  return { kind: "new", id: uuidv7(), agentCode }
}

/**
 * Creates the target of a turn that starts a job of the agent `researcher`
 * titled `Find what moths eat`.
 *
 * @param parentConversationId - Conversation the job is started from.
 * @param jobCallId - The `delegate_work` call that sends the job message.
 * @returns The target with a fresh UUIDv7.
 */
export function createNewJobTarget(
  parentConversationId: string,
  jobCallId: string
): Extract<ConversationTurnTarget, { kind: "new-job" }> {
  return {
    kind: "new-job",
    id: uuidv7(),
    agentCode: "researcher",
    parentConversationId,
    title: "Find what moths eat",
    jobCallId
  }
}

/**
 * Creates the user message of a turn before it is stored, without
 * attachments. The turn's target says who writes it.
 *
 * @param content - Authored text.
 * @returns The message with a fresh UUIDv7, as the chat route makes one.
 */
export function createTurnUserMessage(
  content: string
): ConversationTurnUserMessage {
  return { id: uuidv7(), content, attachments: [] }
}

/** Lifecycle fields that distinguish assistant-message fixtures. */
export type AssistantMessageFixtureState =
  | Readonly<{ status: "completed"; finishReason: "stop" | "length" }>
  | Readonly<{ status: "streaming" | "interrupted" | "failed" }>

/** Times a part fixture is stored with. */
export type PartFixtureTimes = Readonly<{
  /** Time the part was stored. */
  createdAt: string
  /** Time of the part's latest change. */
  updatedAt: string
}>

/** Times of a part stored at the fixture time and never changed. */
const FIXTURE_PART_TIMES: PartFixtureTimes = Object.freeze({
  createdAt: FIXTURE_TIMESTAMP,
  updatedAt: FIXTURE_TIMESTAMP
})

/** Values that distinguish one text-part fixture from another. */
export type TextPartFixture = Readonly<{
  /** Identity sequence of the part. */
  sequence: number
  /** Zero-based round of the part. */
  round: number
  /** Non-empty text. */
  content: string
  /**
   * When the part was stored and last changed; the fixture time when
   * omitted.
   */
  times?: PartFixtureTimes
}>

/**
 * Creates a stored text part.
 *
 * @param fixture - Identity, round, text, and times of the part.
 * @returns A valid text part.
 */
export function createTextPart(fixture: TextPartFixture): ReplyPart {
  const times = fixture.times ?? FIXTURE_PART_TIMES
  return {
    kind: "text",
    id: createFixtureUuidV7(fixture.sequence),
    round: fixture.round,
    createdAt: times.createdAt,
    updatedAt: times.updatedAt,
    content: fixture.content
  }
}

/**
 * Formats the text a message shows: a user message's content, or the text of
 * every text part of a reply, joined.
 *
 * @param message - Stored message.
 * @returns The text, empty for a reply without text parts.
 */
export function formatMessageText(message: ConversationMessage): string {
  if (message.role === "user") return message.content
  return message.parts
    .flatMap((part) => (part.kind === "text" ? [part.content] : []))
    .join("")
}

/**
 * Creates a stored reasoning part.
 *
 * @param sequence - Identity sequence of the part.
 * @param round - Zero-based round of the part.
 * @param content - Non-empty reasoning.
 * @returns A valid reasoning part stored at the fixture time.
 */
export function createReasoningPart(
  sequence: number,
  round: number,
  content: string
): ReplyPart {
  return {
    kind: "reasoning",
    id: createFixtureUuidV7(sequence),
    round,
    createdAt: FIXTURE_TIMESTAMP,
    updatedAt: FIXTURE_TIMESTAMP,
    content
  }
}

/** Values that distinguish one tool-call part fixture from another. */
export type ToolCallPartFixture = Readonly<{
  /** Identity sequence of the call. */
  sequence: number
  /** Zero-based round of the call. */
  round: number
  /** Called tool name. */
  toolName: string
  /** The model's argument text. */
  argumentText: string
}>

/**
 * State of one tool-call part fixture: its status, with its result when the
 * status has one and the numbers of the sources a succeeded result shows.
 */
export type ToolCallPartFixtureState =
  | Readonly<{
      /** A call without a result. */
      status: "awaiting-approval" | "running" | "interrupted"
    }>
  | Readonly<{
      /** A call that ran and returned its output. */
      status: "succeeded"
      /** Text the model read; may be empty. */
      result: string
      /** Numbers of the sources the result shows, in its order. */
      sourceNumbers: readonly number[]
    }>
  | Readonly<{
      /** A call that ended without output. */
      status: "failed" | "rejected"
      /** Non-empty explanation the model read. */
      result: string
    }>

/**
 * Creates a stored tool call.
 *
 * @param fixture - Identity, round, tool, and arguments.
 * @param state - The call's state.
 * @returns A valid tool-call part stored at the fixture time.
 */
export function createToolCallPart(
  fixture: ToolCallPartFixture,
  state: ToolCallPartFixtureState
): ToolCallReplyPart {
  const common = {
    id: createFixtureUuidV7(fixture.sequence),
    round: fixture.round,
    createdAt: FIXTURE_TIMESTAMP,
    updatedAt: FIXTURE_TIMESTAMP,
    toolName: fixture.toolName,
    argumentText: fixture.argumentText
  }
  switch (state.status) {
    case "succeeded":
      return {
        kind: "tool-call",
        ...common,
        status: state.status,
        result: state.result,
        sourceNumbers: state.sourceNumbers
      }
    case "failed":
    case "rejected":
      return {
        kind: "tool-call",
        ...common,
        status: state.status,
        result: state.result
      }
    case "awaiting-approval":
    case "running":
    case "interrupted":
      return {
        kind: "tool-call",
        ...common,
        status: state.status
      }
  }
}

/**
 * Creates a stored assistant message.
 *
 * @param sequence - Identity sequence of the message.
 * @param parts - Stored parts in order; empty for a reply without any.
 * @param state - Lifecycle status and, for completed replies, finish reason.
 * @returns A valid assistant message from model `fixture-model`.
 */
export function createAssistantMessage(
  sequence: number,
  parts: readonly ReplyPart[],
  state: AssistantMessageFixtureState
): ConversationAssistantMessage {
  return {
    id: createFixtureUuidV7(sequence),
    role: "assistant",
    model: "fixture-model",
    parts,
    status: state.status,
    finishReason: state.status === "completed" ? state.finishReason : null,
    createdAt: FIXTURE_TIMESTAMP,
    updatedAt: FIXTURE_TIMESTAMP
  }
}

/** Values that distinguish one turn fixture from another. */
export type ConversationTurnFixture = Readonly<{
  /** Code of the conversation's agent. */
  agentCode: string
  /** Transcript before the new turn. */
  earlierMessages: readonly ConversationMessage[]
  /** Content of the new user message. */
  userMessageContent: string
  /** Sources the conversation stored before the turn; omitted means none. */
  sources?: readonly ConversationSource[]
}>

/**
 * Creates a persisted turn for an untitled existing main conversation
 * without jobs.
 *
 * @param fixture - Agent code, earlier transcript, and new user content.
 * @returns A turn whose new pair uses identity sequences 1001 and 1002.
 */
export function createConversationTurn(
  fixture: ConversationTurnFixture
): ConversationTurn {
  return {
    conversation: {
      id: FIXTURE_CONVERSATION_ID,
      title: null,
      agentCode: fixture.agentCode,
      parentConversationId: null,
      jobNumber: null,
      delegatorAgentCode: null,
      createdAt: FIXTURE_TIMESTAMP,
      updatedAt: FIXTURE_TIMESTAMP,
      messages: [...fixture.earlierMessages],
      sources: fixture.sources ?? [],
      jobs: []
    },
    userMessage: createUserMessage(1001, fixture.userMessageContent),
    assistantMessage: createAssistantMessage(1002, [], {
      status: "streaming"
    }),
    isNewConversation: false
  }
}
