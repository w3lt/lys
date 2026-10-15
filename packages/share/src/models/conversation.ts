import * as z from "zod"
import { agentCodeSchema } from "./agent"

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

/** Validates a non-empty user-authored message in a persisted conversation. */
export const conversationUserMessageSchema = z.strictObject({
  ...conversationMessageBase,
  role: z.literal("user"),
  /** Non-empty authored content retained in the conversation transcript. */
  content: z.string().min(1)
})

/**
 * Validates the number Lys gives one source of a conversation.
 *
 * @remarks Numbers start at 1 and count up across the whole conversation;
 * the model cites a source by writing its number in square brackets.
 */
const conversationSourceNumberSchema = z.int().min(1)

/**
 * Validates one web source a conversation's tool calls read.
 *
 * @remarks A conversation stores each URL once, under one number that never
 * changes; a later read of the same URL reuses it. The title is the one
 * shown to the model when the source was first numbered, flattened onto one
 * line.
 */
export const conversationSourceSchema = z.strictObject({
  /** Number the model cites the source by; unique within the conversation. */
  number: conversationSourceNumberSchema,
  /** Normalized `http` or `https` address of the source. */
  url: z.url({ protocol: /^https?$/ }),
  /** Non-empty title of the page or search result. */
  title: z.string().min(1)
})

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
   * latest state.
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
  argumentText: z.string(),
  /**
   * Numbers of the conversation's sources the result shows, in the order it
   * shows them; empty when it shows none.
   */
  sourceNumbers: z.array(conversationSourceNumberSchema).readonly()
}

/**
 * Validates a tool call that has no result: waiting for the person's
 * approval, running, or interrupted before it had one.
 */
const pendingToolCallReplyPartSchema = z.strictObject({
  ...toolCallReplyPartBase,
  /**
   * `awaiting-approval`: shown to the person, who has not answered;
   * `running`: allowed and running in the desktop or the backend;
   * `interrupted`: the reply ended while the call waited or ran.
   */
  status: z.enum(["awaiting-approval", "running", "interrupted"])
})

/** Validates a tool call that ran and returned its output. */
const succeededToolCallReplyPartSchema = z.strictObject({
  ...toolCallReplyPartBase,
  status: z.literal("succeeded"),
  /** Text the model read as the result; empty when the tool returned nothing. */
  result: z.string()
})

/**
 * Validates a tool call that ended without output: it could not run, the
 * tool reported a failure, or the person rejected it.
 */
const unsuccessfulToolCallReplyPartSchema = z.strictObject({
  ...toolCallReplyPartBase,
  /**
   * `failed`: the call was invalid or the tool failed; `rejected`: the
   * person did not allow it.
   */
  status: z.enum(["failed", "rejected"]),
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
  /** Non-empty model identifier that produced or owns the reply. */
  model: z.string().min(1),
  role: z.literal("assistant"),
  /**
   * Parts in the order they were stored; empty before the first one or when
   * generation fails at once.
   */
  parts: z.array(replyPartSchema).readonly(),
  status: conversationAssistantMessageStatusSchema,
  /** Null while the reply is streaming, interrupted, or failed. */
  finishReason: conversationAssistantMessageFinishReasonSchema.nullable(),
  /** Last modification time, updated as the reply's parts or state change. */
  updatedAt: timestampSchema
})

/** Validates either role-specific message shape using the `role` discriminant. */
export const conversationMessageSchema = z.discriminatedUnion("role", [
  conversationUserMessageSchema,
  conversationAssistantMessageSchema
])

/** Validates the persisted conversation record and its ordered message history. */
export const conversationSchema = z.strictObject({
  id: z.uuidv7(),
  /** Non-empty title; null until title generation saves one. */
  title: z.string().min(1).nullable(),
  /**
   * Code of the agent that answers the conversation, set when it is created;
   * every turn sends that agent's current system prompt.
   */
  agentCode: agentCodeSchema,
  /** Messages remain in persisted conversation order. */
  messages: z.array(conversationMessageSchema),
  /** Sources the conversation's tool calls read, in number order. */
  sources: z.array(conversationSourceSchema).readonly(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema
})

/** Validates conversation metadata without the messages and sources. */
export const conversationMetadataSchema = conversationSchema.omit({
  messages: true,
  sources: true
})

/** User-authored message accepted by the persisted conversation contract. */
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
export type ToolCallReplyPartStatus = ToolCallReplyPart["status"]

/** One numbered web source of a conversation. */
export type ConversationSource = z.infer<typeof conversationSourceSchema>

/** Persisted conversation record including its ordered message history. */
export type Conversation = z.infer<typeof conversationSchema>

/** Persisted conversation metadata used when message history is not transferred. */
export type ConversationMetadata = z.infer<typeof conversationMetadataSchema>

/** Assistant message lifecycle state inferred from its authoritative schema. */
export type ConversationAssistantMessageStatus = z.infer<
  typeof conversationAssistantMessageStatusSchema
>

/** Model completion reason inferred from the authoritative conversation schema. */
export type ConversationAssistantMessageFinishReason = z.infer<
  typeof conversationAssistantMessageFinishReasonSchema
>
