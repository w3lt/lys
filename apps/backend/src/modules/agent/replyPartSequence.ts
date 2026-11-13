import type { ChatGenerationEvent, ChatToolApprovalAnswer } from "@lys/protocol"
import {
  replyPartSchema,
  type ConversationSource,
  type ReplyPart,
  type ToolCallReplyPart
} from "@lys/share"
import { v7 as uuidv7 } from "uuid"
import type { ToolCallDecisionRecord } from "../toolApproval/toolCallDecisionRecord"

/** Reasoning or text of one round, as the agent asks to store it. */
type ReplyFragmentDraft = Readonly<{
  /** Zero-based model round the fragment belongs to. */
  round: number
  /** Non-empty first fragment of the part. */
  content: string
}>

/** Fields every tool call the agent asks to store has. */
type ReplyToolCallDraftBase = Readonly<{
  /** Kind of the stored part. */
  kind: "tool-call"
  /** UUIDv7 the agent gave the call; the part's identity. */
  id: string
  /** Zero-based model round the call belongs to. */
  round: number
  /** Name the model called, as it wrote it. */
  toolName: string
  /** Argument text as the model wrote it. */
  argumentText: string
  /**
   * How the backend decided the call before it ran; stored with the call
   * and never shown to the model or a follower.
   */
  decision: ToolCallDecisionRecord
}>

/**
 * One new part of a reply, as the agent asks to store it; the store gives a
 * reasoning or text part its identity and every part its times.
 *
 * @remarks A tool call starts `awaiting-approval` when the person will be
 * asked, before the prompt is sent; `running` when it may run at once; or
 * `failed` with the message the model reads when it cannot run at all.
 */
export type ReplyPartDraft =
  | (ReplyFragmentDraft & Readonly<{ kind: "reasoning" }>)
  | (ReplyFragmentDraft & Readonly<{ kind: "text" }>)
  | (ReplyToolCallDraftBase &
      Readonly<{
        /** The call waits for the person, or may run at once. */
        status: "awaiting-approval" | "running"
      }>)
  | (ReplyToolCallDraftBase &
      Readonly<{
        /** The call cannot run: an unknown tool or arguments it rejects. */
        status: "failed"
        /** Non-empty explanation the model reads. */
        result: string
      }>)

/**
 * One change of a stored tool call.
 *
 * @remarks `running` follows the person's approval of a waiting call;
 * `rejected` answers a waiting call that was not allowed, with why;
 * `expired` ends a waiting call whose prompt reached its time limit, and is
 * stored as `failed`; `succeeded` and `failed` end a running call with the
 * text the model reads.
 */
export type ReplyToolCallChange =
  | Readonly<{
      /** The person allowed the call, which now runs. */
      status: "running"
    }>
  | Readonly<{
      /** The call ran and returned its output. */
      status: "succeeded"
      /** Text the model reads; may be empty. */
      result: string
      /**
       * Numbered sources the result shows, in its order; empty when it
       * shows none.
       */
      sources: readonly ConversationSource[]
    }>
  | Readonly<{
      /** The call failed while running. */
      status: "failed"
      /** Non-empty explanation the model reads. */
      result: string
    }>
  | Readonly<{
      /** The call was not allowed. */
      status: "rejected"
      /** Non-empty explanation the model reads. */
      result: string
      /**
       * Why: `declined` when the person rejected the call, `showFailed`
       * when the client could not show it to them.
       */
      reason: Extract<ChatToolApprovalAnswer, { status: "rejected" }>["reason"]
    }>
  | Readonly<{
      /**
       * Nobody answered the call's prompt within its time limit, so the
       * call never ran; stored as failed.
       */
      status: "expired"
      /** Non-empty explanation the model reads. */
      result: string
    }>

/**
 * Builds the complete part a draft describes.
 *
 * @param draft - Part the agent asks to store.
 * @param now - Time of the operation, stored as both of the part's times.
 * @returns The validated part; a reasoning or text part gets a new UUIDv7, a
 * tool call keeps its own identifier and leaves its decision out. No draft is
 * a succeeded call, so none shows sources.
 * @throws If the draft breaks the part contract, such as empty text or an
 * empty failure message.
 */
export function buildReplyPart(draft: ReplyPartDraft, now: string): ReplyPart {
  if (draft.kind !== "tool-call")
    return replyPartSchema.parse({
      kind: draft.kind,
      id: uuidv7(),
      round: draft.round,
      createdAt: now,
      updatedAt: now,
      content: draft.content
    })
  const toolCall = {
    kind: draft.kind,
    id: draft.id,
    round: draft.round,
    toolName: draft.toolName,
    argumentText: draft.argumentText,
    createdAt: now,
    updatedAt: now
  }
  return replyPartSchema.parse(
    draft.status === "failed"
      ? { ...toolCall, status: draft.status, result: draft.result }
      : { ...toolCall, status: draft.status }
  )
}

/** What a reply's part sequence needs from its turn. */
export type ReplyPartSequenceDependencies = Readonly<{
  /**
   * Stores a new part after the reply's last one; returns the stored part,
   * or undefined when the reply is no longer streaming.
   */
  createReplyPart: (draft: ReplyPartDraft) => ReplyPart | undefined
  /**
   * Appends a fragment to a stored reasoning or text part; returns the
   * time it was stored, or undefined when the reply is no longer streaming.
   */
  updateReplyPartContent: (
    partId: string,
    content: string
  ) => string | undefined
  /**
   * Stores one change of a tool call; returns the call as stored, or
   * undefined when the reply is no longer streaming or the call is not in a
   * state that permits the change.
   */
  updateReplyToolCall: (
    toolCallId: string,
    change: ReplyToolCallChange
  ) => ToolCallReplyPart | undefined
  /** Queues one event for every stream following the reply; never waits. */
  sendEvent: (event: ChatGenerationEvent) => void
}>

/** Reasoning or text part that the next fragment of its kind may extend. */
type OpenReplyPart = Readonly<{
  /** Kind of the open part. */
  kind: "reasoning" | "text"
  /** Identity of the open part. */
  id: string
  /** Round the open part belongs to. */
  round: number
}>

/**
 * Owns the open reasoning or text part of one reply to store each of the
 * reply's parts and changes before sending it to the reply's followers.
 *
 * @remarks Invariant: a fragment extends the last stored part only when that
 * part is open and has the fragment's kind and round; otherwise it starts a
 * new part, which becomes the open one. A tool call closes the open part.
 * Every method stores first and sends the matching event only after the
 * store accepted it, in the same synchronous step, so a follower that reads a
 * snapshot in its own step sees both or neither. A refused write sends
 * nothing and returns false: the reply was superseded, deleted, or
 * finalized. Owns no resource; the turn's capabilities are borrowed for the
 * reply. Concurrency model: single-owner, used by one reply on the backend's
 * event loop.
 */
export default class ReplyPartSequence {
  /** Turn capabilities borrowed for the reply. */
  readonly #dependencies: ReplyPartSequenceDependencies
  /** Part the next fragment of its kind and round extends; none at first. */
  #openPart: OpenReplyPart | undefined = undefined

  /**
   * Creates the sequence of a reply that has no part yet.
   *
   * @param dependencies - Part storage and event sender of the reply's turn.
   */
  public constructor(dependencies: ReplyPartSequenceDependencies) {
    this.#dependencies = dependencies
  }

  /**
   * Stores and sends one reasoning fragment of a round.
   *
   * @param round - Zero-based round of the fragment.
   * @param content - Non-empty fragment in stream order.
   * @returns True once stored and sent; false when the reply refused it.
   */
  public updateReplyReasoning(round: number, content: string): boolean {
    return this.#updateReplyFragment("reasoning", round, content)
  }

  /**
   * Stores and sends one text fragment of a round.
   *
   * @param round - Zero-based round of the fragment.
   * @param content - Non-empty fragment in stream order.
   * @returns True once stored and sent; false when the reply refused it.
   */
  public updateReplyText(round: number, content: string): boolean {
    return this.#updateReplyFragment("text", round, content)
  }

  /**
   * Stores and sends a new tool call, closing the open part.
   *
   * @param draft - The call in its first state.
   * @returns True once stored and sent; false when the reply refused it.
   */
  public createReplyToolCall(
    draft: Extract<ReplyPartDraft, { kind: "tool-call" }>
  ): boolean {
    this.#openPart = undefined
    const part = this.#dependencies.createReplyPart(draft)
    if (part === undefined) return false
    this.#dependencies.sendEvent({ type: "reply-part", part })
    return true
  }

  /**
   * Stores and sends one change of a tool call: its sources first, when the
   * change brings any, then the changed call.
   *
   * @param toolCallId - Identifier of a stored call of this reply.
   * @param change - The call's next state.
   * @returns True once stored and sent; false when the reply refused it.
   */
  public updateReplyToolCall(
    toolCallId: string,
    change: ReplyToolCallChange
  ): boolean {
    const part = this.#dependencies.updateReplyToolCall(toolCallId, change)
    if (part === undefined) return false
    if (change.status === "succeeded" && change.sources.length > 0)
      this.#dependencies.sendEvent({ type: "sources", sources: change.sources })
    this.#dependencies.sendEvent({ type: "reply-part", part })
    return true
  }

  /**
   * Stores and sends one reasoning or text fragment, extending the open part
   * or starting a new one.
   *
   * @param kind - Kind of the fragment.
   * @param round - Zero-based round of the fragment.
   * @param content - Non-empty fragment in stream order.
   * @returns True once stored and sent; false when the reply refused it.
   */
  #updateReplyFragment(
    kind: OpenReplyPart["kind"],
    round: number,
    content: string
  ): boolean {
    const openPart = this.#openPart
    if (openPart?.kind === kind && openPart.round === round)
      return this.#updateOpenPart(openPart.id, content)
    this.#openPart = undefined
    const part = this.#dependencies.createReplyPart({ kind, round, content })
    if (part === undefined) return false
    this.#openPart = Object.freeze({ kind, id: part.id, round })
    this.#dependencies.sendEvent({ type: "reply-part", part })
    return true
  }

  /**
   * Stores and sends one fragment of the open part.
   *
   * @param partId - Identity of the open part.
   * @param content - Non-empty fragment in stream order.
   * @returns True once stored and sent; false when the reply refused it.
   */
  #updateOpenPart(partId: string, content: string): boolean {
    const updatedAt = this.#dependencies.updateReplyPartContent(partId, content)
    if (updatedAt === undefined) return false
    this.#dependencies.sendEvent({
      type: "reply-part-delta",
      partId,
      content,
      updatedAt
    })
    return true
  }
}
