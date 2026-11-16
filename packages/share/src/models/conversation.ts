import * as z from "zod"
import { agentCodeSchema } from "./agent"
import {
  conversationAttachmentSchema,
  hasDistinctAttachmentNames,
  type ConversationAttachment
} from "./attachment"
import { llmProviderSchema } from "./providers"

/** Validates ISO-8601 timestamps persisted with exactly millisecond precision. */
const timestampSchema = z.iso.datetime({ precision: 3 })

/** Lifecycle states permitted for a persisted assistant message. */
const conversationAssistantMessageStatusSchema = z.enum([
  "streaming",
  "completed",
  "interrupted",
  "failed"
])

/** Terminal model completion reasons shared with the chat stream `done` event. */
const conversationAssistantMessageFinishReasonSchema = z.enum([
  "stop",
  "length"
])

/** Common UUIDv7 identity and creation timestamp shared by both message roles. */
const conversationMessageBase = {
  /** UUIDv7 message identity used by persistence and stream updates. */
  id: z.uuidv7(),
  /** Creation time represented with the shared millisecond timestamp precision. */
  createdAt: timestampSchema
}

/**
 * Answers whether no two attachments of a message share a name ignoring
 * case.
 *
 * @param attachments - Attachments of one message.
 * @returns True when every name is distinct by the attachment name rules.
 */
function hasDistinctAttachments(
  attachments: readonly ConversationAttachment[]
): boolean {
  return hasDistinctAttachmentNames(
    attachments.map((attachment) => attachment.name)
  )
}

/**
 * Validates the number Lys gives one source of a conversation.
 *
 * @remarks Numbers start at 1 and count up across the whole conversation;
 * the model cites a source by writing its number in square brackets.
 */
const conversationSourceNumberSchema = z.int().min(1)

/**
 * Validates who wrote a user-role message.
 *
 * @remarks `person`: the person. `delegator`: the delegator of a job, which
 * wrote a job message. `wake-up`: the backend, which wrote a wake-up
 * message.
 */
export const conversationMessageOriginSchema = z.enum([
  "person",
  "delegator",
  "wake-up"
])

/**
 * Validates what a report says.
 *
 * @remarks `note`: a progress note. The others end one reply of the job:
 * `result` with its result, `failed` with a failure, `stopped` with a stop,
 * and `interrupted` with an interruption.
 */
export const jobReportKindSchema = z.enum([
  "note",
  "result",
  "failed",
  "stopped",
  "interrupted"
])

/**
 * Answers whether numbers ascend, each greater than the one before it, so
 * none appears twice.
 *
 * @param numbers - Numbers in their given order.
 * @returns True when each number is greater than the one before it; true
 * for an empty list.
 */
function isAscending(numbers: readonly number[]): boolean {
  let previousNumber = Number.NEGATIVE_INFINITY
  for (const number of numbers) {
    if (number <= previousNumber) return false
    previousNumber = number
  }
  return true
}

/** Fields every report has, whatever it says. */
const jobReportBase = {
  /** UUIDv7 identity of the report. */
  id: z.uuidv7(),
  /** The job: its conversation id. */
  jobId: z.uuidv7(),
  /** The job's number in its parent, from 1. */
  jobNumber: z.int().min(1),
  /** Code of the agent that works on the job. */
  agentCode: agentCodeSchema,
  /**
   * Title of the job message this report answers; a later continuation
   * never changes it.
   */
  title: z.string().min(1),
  /** Time the report was written. */
  createdAt: timestampSchema
}

/**
 * Fields every report that may have text has: a note, a result, and a
 * failure.
 */
const textJobReportBase = {
  ...jobReportBase,
  /**
   * Numbers of the parent conversation's sources the content cites,
   * ascending, so each once; empty when none.
   */
  sourceNumbers: z
    .array(conversationSourceNumberSchema)
    .refine(
      isAscending,
      "A report lists the sources it cites in ascending order, each once."
    )
    .readonly()
}

/** Validates a progress note. */
const noteJobReportSchema = z.strictObject({
  ...textJobReportBase,
  kind: jobReportKindSchema.extract(["note"]),
  /** The note; never empty. */
  content: z.string().min(1)
})

/** Validates the result that ended a reply. */
const resultJobReportSchema = z.strictObject({
  ...textJobReportBase,
  kind: jobReportKindSchema.extract(["result"]),
  /** Text of the reply's last round, possibly empty. */
  content: z.string()
})

/** Validates the failure that ended a reply. */
const failedJobReportSchema = z.strictObject({
  ...textJobReportBase,
  kind: jobReportKindSchema.extract(["failed"]),
  /** The failure sentence; never empty. */
  content: z.string().min(1)
})

/** Validates the stop that ended a reply, which has no text. */
const stoppedJobReportSchema = z.strictObject({
  ...jobReportBase,
  kind: jobReportKindSchema.extract(["stopped"]),
  /** Always empty. */
  content: z.literal(""),
  /** Always empty: the report has no text to cite from. */
  sourceNumbers: z.tuple([]).readonly()
})

/** Validates the interruption that ended a reply, which has no text. */
const interruptedJobReportSchema = z.strictObject({
  ...jobReportBase,
  kind: jobReportKindSchema.extract(["interrupted"]),
  /** Always empty. */
  content: z.literal(""),
  /** Always empty: the report has no text to cite from. */
  sourceNumbers: z.tuple([]).readonly()
})

/**
 * Validates one report a job sent to its delegator, as delivered with a
 * user-role message of the parent conversation, in the variant its kind
 * selects.
 *
 * @remarks `note` and `failed` have text, `result` may have none, and
 * `stopped` and `interrupted` have none, so they cite no source.
 */
export const jobReportSchema = z.discriminatedUnion("kind", [
  noteJobReportSchema,
  resultJobReportSchema,
  failedJobReportSchema,
  stoppedJobReportSchema,
  interruptedJobReportSchema
])

/**
 * Validates a non-empty user-role message in a persisted conversation: one
 * the person wrote, a job message, or a wake-up message.
 */
export const conversationUserMessageSchema = z.strictObject({
  ...conversationMessageBase,
  role: z.literal("user"),
  /** Non-empty authored content retained in the conversation transcript. */
  content: z.string().min(1),
  /**
   * Attachments sent with the message, in the order they were sent, each
   * name once ignoring case; empty when it has none.
   */
  attachments: z
    .array(conversationAttachmentSchema)
    .refine(
      hasDistinctAttachments,
      "A message names each attachment once, ignoring case."
    )
    .readonly(),
  /** Who wrote the message. */
  origin: conversationMessageOriginSchema,
  /**
   * Reports delivered with this message, oldest first; empty for most
   * messages. Only a message of a conversation that has jobs carries any.
   */
  reports: z.array(jobReportSchema).readonly()
})

/**
 * Validates one web source a conversation's tool calls read, or one a report
 * delivered to it cites.
 *
 * @remarks A conversation stores each URL once, under one number that never
 * changes; a later read of the same URL reuses it. The title is the one
 * shown to the model when the source was first numbered, flattened onto one
 * line and without the characters a person cannot see.
 */
export const conversationSourceSchema = z.strictObject({
  /** Number the model cites the source by; unique within the conversation. */
  number: conversationSourceNumberSchema,
  /** Normalized `http` or `https` address of the source. */
  url: z.url({ protocol: /^https?$/ }),
  /** Non-empty title of the page or search result. */
  title: z.string().min(1)
})

/**
 * Finds each `[n]` citation marker in a text; its group is the number of the
 * cited source, written without leading zeros, since a conversation numbers
 * its sources from 1. The backend renumbers the markers of a delivered
 * report with it, and the desktop links the markers a reply shows.
 *
 * @remarks Frozen and shared: a call that would move its `lastIndex`, such
 * as `exec`, `test`, or `replace`, throws a `TypeError`. Use it with
 * `matchAll`, which copies it.
 */
export const CITATION_MARKER_PATTERN = Object.freeze(/\[([1-9]\d*)\]/g)

/** Fields every part of a reply has. */
const replyPartBase = {
  /** UUIDv7 identity of the part; a tool call's is the call's identifier. */
  id: z.uuidv7(),
  /** Zero-based model round the part belongs to. */
  round: z.int().nonnegative(),
  /** Time the part was stored. */
  createdAt: timestampSchema,
  /**
   * Time of the part's latest change: its last fragment, or a tool call's
   * latest state. A call interrupted when its reply ended keeps the time the
   * reply ended; one that startup recovery interrupted keeps the time of its
   * last change before Lys stopped.
   */
  updatedAt: timestampSchema
}

/**
 * Validates a stretch of reasoning the model sent in one round, apart from
 * its reply text.
 */
const reasoningReplyPartSchema = z.strictObject({
  kind: z.literal("reasoning"),
  ...replyPartBase,
  /** Non-empty reasoning text in stream order. */
  content: z.string().min(1)
})

/** Validates a stretch of reply text the model wrote in one round. */
const textReplyPartSchema = z.strictObject({
  kind: z.literal("text"),
  ...replyPartBase,
  /** Non-empty reply text in stream order. */
  content: z.string().min(1)
})

/** Fields every tool-call part has, whatever its state. */
const toolCallReplyPartBase = {
  kind: z.literal("tool-call"),
  ...replyPartBase,
  /**
   * Name the model called; it may name a tool that was not offered, or be
   * empty, when the model wrote one.
   */
  toolName: z.string(),
  /** Argument text as the model wrote it; possibly not valid JSON. */
  argumentText: z.string()
}

/**
 * Validates the state of one tool call of a reply.
 *
 * @remarks `awaiting-approval`: shown to the person, who has not answered;
 * `running`: allowed and running in the desktop or the backend;
 * `interrupted`: the reply ended while the call waited or ran;
 * `succeeded`: it ran and returned its output; `failed`: the call was
 * invalid or the tool failed; `rejected`: the person did not allow it.
 */
export const toolCallReplyPartStatusSchema = z.enum([
  "awaiting-approval",
  "running",
  "interrupted",
  "succeeded",
  "failed",
  "rejected"
])

/**
 * Validates a tool call that has no result: waiting for the person's
 * approval, running, or interrupted before it had one.
 */
const pendingToolCallReplyPartSchema = z.strictObject({
  ...toolCallReplyPartBase,
  status: toolCallReplyPartStatusSchema.extract([
    "awaiting-approval",
    "running",
    "interrupted"
  ])
})

/** Validates a tool call that ran and returned its output. */
const succeededToolCallReplyPartSchema = z.strictObject({
  ...toolCallReplyPartBase,
  status: toolCallReplyPartStatusSchema.extract(["succeeded"]),
  /** Text the model read as the result; empty when the tool returned nothing. */
  result: z.string(),
  /**
   * Numbers of the conversation's sources the result shows, in the order it
   * shows them; empty when it shows none.
   */
  sourceNumbers: z.array(conversationSourceNumberSchema).readonly()
})

/**
 * Validates a tool call that ended without output: it could not run, the
 * tool reported a failure, or the person rejected it.
 */
const unsuccessfulToolCallReplyPartSchema = z.strictObject({
  ...toolCallReplyPartBase,
  status: toolCallReplyPartStatusSchema.extract(["failed", "rejected"]),
  /** Non-empty explanation the model read instead of a result. */
  result: z.string().min(1)
})

/**
 * Validates one tool call of a reply, in the state its status selects.
 *
 * @remarks Only `succeeded`, `failed`, and `rejected` carry the result the
 * model read.
 */
const toolCallReplyPartSchema = z.discriminatedUnion("status", [
  pendingToolCallReplyPartSchema,
  succeededToolCallReplyPartSchema,
  unsuccessfulToolCallReplyPartSchema
])

/**
 * Validates one part of a reply, selected by `kind`.
 *
 * @remarks A reply is its parts in order: each round's reasoning, text, and
 * tool calls, as the model produced them.
 */
export const replyPartSchema = z.discriminatedUnion("kind", [
  reasoningReplyPartSchema,
  textReplyPartSchema,
  toolCallReplyPartSchema
])

/** Validates an assistant message, including its generation lifecycle state. */
export const conversationAssistantMessageSchema = z.strictObject({
  ...conversationMessageBase,
  /** Non-empty key of the model that produced or owns the reply. */
  model: z.string().min(1),
  /**
   * Provider of that model; null for a reply stored before Lys recorded
   * providers, whose provider is unknown.
   */
  provider: llmProviderSchema.nullable(),
  role: z.literal("assistant"),
  /**
   * Parts in the order they were stored; empty before the first one or when
   * generation fails at once.
   */
  parts: z.array(replyPartSchema).readonly(),
  status: conversationAssistantMessageStatusSchema,
  /** Null while the reply is streaming, interrupted, or failed. */
  finishReason: conversationAssistantMessageFinishReasonSchema.nullable(),
  /**
   * Time of the reply's latest state change: its creation, or the write that
   * ended it. Writing a part changes the part's own `updatedAt`, not this.
   */
  updatedAt: timestampSchema
})

/** Validates either role-specific message shape using the `role` discriminant. */
export const conversationMessageSchema = z.discriminatedUnion("role", [
  conversationUserMessageSchema,
  conversationAssistantMessageSchema
])

/**
 * Validates the state of a job, read from its latest reply.
 *
 * @remarks `working`: that reply is streaming. `replied`: it completed.
 * `failed`: it failed. `interrupted`: it was interrupted and its end report
 * says `interrupted`. `stopped`: it was interrupted otherwise.
 */
export const jobStateSchema = z.enum([
  "working",
  "replied",
  "failed",
  "stopped",
  "interrupted"
])

/** Validates one job of a conversation, as its card shows it. */
export const jobSchema = z.strictObject({
  /** The job conversation's id. */
  id: z.uuidv7(),
  /** The job's number in its parent, from 1. */
  number: z.int().min(1),
  /** Code of the agent that works on the job. */
  agentCode: agentCodeSchema,
  /** Title of the latest job message. */
  title: z.string().min(1),
  /** State of the job, read from its latest reply. */
  state: jobStateSchema,
  /**
   * Newest progress note of the job's latest reply; null when that reply
   * sent none.
   */
  latestNote: z.string().min(1).nullable(),
  /** The job's latest reply: an assistant message id in the job conversation. */
  replyId: z.uuidv7(),
  /**
   * Tool-call ids, in the parent conversation, of the `delegate_work` calls
   * that sent the job's messages, oldest first; never empty.
   */
  jobCallIds: z.array(z.uuidv7()).min(1).readonly(),
  /** Time the job conversation was created. */
  createdAt: timestampSchema,
  /** The job conversation's `updatedAt` when the job was read. */
  updatedAt: timestampSchema
})

/**
 * Validates the fields every conversation has, a main conversation or a
 * job.
 *
 * @remarks Both variants of a conversation extend it, and read projections
 * such as the history's summary pick their fields from it. It is not a
 * conversation contract of its own: it lacks `kind`, which tells a main
 * conversation from a job, and the fields each kind pairs.
 */
export const conversationBaseSchema = z.strictObject({
  /** UUIDv7 identity of the conversation. */
  id: z.uuidv7(),
  /** Non-empty title; null until title generation saves one. */
  title: z.string().min(1).nullable(),
  /**
   * Code of the agent that answers the conversation, set when it is created;
   * every turn sends that agent's current system prompt.
   */
  agentCode: agentCodeSchema,
  /** Time the conversation was created. */
  createdAt: timestampSchema,
  /** Time of the conversation's latest activity. */
  updatedAt: timestampSchema
})

/** Validates the metadata of a main conversation, which no job started. */
const mainConversationMetadataSchema = conversationBaseSchema.extend({
  /** Selects the main conversation's variant. */
  kind: z.literal("main"),
  /** A main conversation has no parent. */
  parentConversationId: z.null(),
  /** A main conversation has no job number. */
  jobNumber: z.null(),
  /** A main conversation has no delegator. */
  delegatorAgentCode: z.null()
})

/** Validates the metadata of a job: a conversation started from another. */
const jobConversationMetadataSchema = conversationBaseSchema.extend({
  /** Selects the job's variant. */
  kind: z.literal("job"),
  /** Conversation this job was started from. */
  parentConversationId: z.uuidv7(),
  /** The job's number in its parent, from 1. */
  jobNumber: z.int().min(1),
  /**
   * Code of the parent conversation's agent, which wrote the job's
   * messages.
   */
  delegatorAgentCode: agentCodeSchema
})

/** Transcript fields every conversation has beside its metadata. */
const conversationTranscriptBase = {
  /** Messages remain in persisted conversation order. */
  messages: z.array(conversationMessageSchema),
  /**
   * Sources the conversation's tool calls read, and those the reports
   * delivered to it cite, in number order.
   */
  sources: z.array(conversationSourceSchema).readonly()
}

/** Validates a main conversation with its transcript and its jobs. */
const mainConversationSchema = mainConversationMetadataSchema.extend({
  ...conversationTranscriptBase,
  /** Jobs started from this conversation, in number order. */
  jobs: z.array(jobSchema).readonly()
})

/** Validates a job with its transcript. */
const jobConversationSchema = jobConversationMetadataSchema.extend({
  ...conversationTranscriptBase,
  /** Always empty: jobs go one level deep, so a job starts none. */
  jobs: z.tuple([]).readonly()
})

/**
 * Validates the persisted conversation record and its ordered message
 * history: a main conversation or a job.
 *
 * @remarks `kind` selects the variant: `main` for a conversation no job
 * started, and `job` for a conversation started from another. A main
 * conversation has no parent, job number, or delegator, and has the jobs
 * started from it. A job has all three and no jobs, because jobs go one
 * level deep. No mixture of the two passes, a kind that names the other
 * variant included.
 */
export const conversationSchema = z.discriminatedUnion("kind", [
  mainConversationSchema,
  jobConversationSchema
])

/**
 * Validates conversation metadata: a conversation without its messages,
 * sources, and jobs, as a main conversation or a job.
 *
 * @remarks `kind` selects the variant, which pairs the parent, the job
 * number, and the delegator as {@link conversationSchema} does.
 */
export const conversationMetadataSchema = z.discriminatedUnion("kind", [
  mainConversationMetadataSchema,
  jobConversationMetadataSchema
])

/** Who wrote a user-role message. */
export type ConversationMessageOrigin = z.infer<
  typeof conversationMessageOriginSchema
>

/** What a report says. */
export type JobReportKind = z.infer<typeof jobReportKindSchema>

/** One report a job sent to its delegator. */
export type JobReport = z.infer<typeof jobReportSchema>

/** State of a job, read from its latest reply. */
export type JobState = z.infer<typeof jobStateSchema>

/** One job of a conversation, as its card shows it. */
export type Job = z.infer<typeof jobSchema>

/**
 * User-role message accepted by the persisted conversation contract,
 * whoever wrote it.
 */
export type ConversationUserMessage = z.infer<
  typeof conversationUserMessageSchema
>
/** Assistant message accepted by the persisted conversation contract. */
export type ConversationAssistantMessage = z.infer<
  typeof conversationAssistantMessageSchema
>
/** Either role-specific message accepted by the persisted conversation contract. */
export type ConversationMessage = z.infer<typeof conversationMessageSchema>

/** One part of a reply, selected by `kind`. */
export type ReplyPart = z.infer<typeof replyPartSchema>

/** One tool call of a reply, in the state its status selects. */
export type ToolCallReplyPart = Extract<ReplyPart, { kind: "tool-call" }>

/** State of one tool call of a reply. */
export type ToolCallReplyPartStatus = z.infer<
  typeof toolCallReplyPartStatusSchema
>

/** A tool call of a reply that has the result the model read. */
export type AnsweredToolCallReplyPart = Extract<
  ToolCallReplyPart,
  { status: "succeeded" | "failed" | "rejected" }
>

/** State of a tool call that has the result the model read. */
export type AnsweredToolCallReplyPartStatus =
  AnsweredToolCallReplyPart["status"]

/**
 * Answers whether a tool call in this state has the result the model read.
 *
 * @param status - State of a tool call.
 * @returns True for `succeeded`, `failed`, and `rejected`; false for
 * `awaiting-approval`, `running`, and `interrupted`.
 */
export function isAnsweredToolCallStatus(
  status: ToolCallReplyPartStatus
): status is AnsweredToolCallReplyPartStatus {
  switch (status) {
    case "succeeded":
    case "failed":
    case "rejected":
      return true
    case "awaiting-approval":
    case "running":
    case "interrupted":
      return false
  }
}

/**
 * Answers whether a tool call has the result the model read.
 *
 * @param call - Tool call of a reply.
 * @returns True when {@link isAnsweredToolCallStatus} answers true for its
 * status.
 */
export function isAnsweredToolCall(
  call: ToolCallReplyPart
): call is AnsweredToolCallReplyPart {
  return isAnsweredToolCallStatus(call.status)
}

/** One numbered web source of a conversation. */
export type ConversationSource = z.infer<typeof conversationSourceSchema>

/**
 * Persisted conversation record including its ordered message history: a
 * main conversation or a job, as `kind` selects.
 */
export type Conversation = z.infer<typeof conversationSchema>

/**
 * Persisted conversation metadata used when message history is not
 * transferred: a main conversation's or a job's, as `kind` selects.
 */
export type ConversationMetadata = z.infer<typeof conversationMetadataSchema>

/** Assistant message lifecycle state inferred from its authoritative schema. */
export type ConversationAssistantMessageStatus = z.infer<
  typeof conversationAssistantMessageStatusSchema
>

/** Model completion reason inferred from the authoritative conversation schema. */
export type ConversationAssistantMessageFinishReason = z.infer<
  typeof conversationAssistantMessageFinishReasonSchema
>
