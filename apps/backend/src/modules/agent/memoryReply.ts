import {
  replyPartSchema,
  type ConversationAssistantMessageStatus,
  type ReplyPart,
  type ToolCallReplyPart
} from "@lys/share"
import type { AssistantMessageCompletion } from "./agent"
import {
  buildReplyPart,
  type ReplyPartDraft,
  type ReplyToolCallChange
} from "./replyPartSequence"

/**
 * Fields a tool call has in every state, with the time of its last change.
 */
type ToolCallPartFields = Pick<
  ToolCallReplyPart,
  | "kind"
  | "id"
  | "round"
  | "createdAt"
  | "updatedAt"
  | "toolName"
  | "argumentText"
>

/**
 * Selects the status a tool call has before a change.
 *
 * @param change - The call's next state.
 * @returns `awaiting-approval` for `running` and `rejected`, which answer
 * the person; `running` for `succeeded` and `failed`, which end a run.
 */
function getPreviousToolCallStatus(
  change: ReplyToolCallChange
): "awaiting-approval" | "running" {
  return change.status === "running" || change.status === "rejected"
    ? "awaiting-approval"
    : "running"
}

/**
 * Builds a tool call after one change.
 *
 * @param part - The call as kept.
 * @param change - The call's next state.
 * @param updatedAt - Time of the change.
 * @returns The validated, frozen call: its new status, the result the model
 * reads when it has one, and the numbers of a succeeded call's sources.
 * @throws If the changed call breaks the part contract.
 */
function buildChangedToolCall(
  part: ToolCallReplyPart,
  change: ReplyToolCallChange,
  updatedAt: string
): ToolCallReplyPart {
  const base: ToolCallPartFields = {
    kind: part.kind,
    id: part.id,
    round: part.round,
    createdAt: part.createdAt,
    updatedAt,
    toolName: part.toolName,
    argumentText: part.argumentText
  }
  switch (change.status) {
    case "running":
      return parseToolCallPart({ ...base, status: change.status })
    case "succeeded":
      return parseToolCallPart({
        ...base,
        status: change.status,
        result: change.result,
        sourceNumbers: change.sources.map((source) => source.number)
      })
    case "failed":
    case "rejected":
      return parseToolCallPart({
        ...base,
        status: change.status,
        result: change.result
      })
  }
}

/**
 * Validates a tool call part.
 *
 * @param candidate - The call's fields.
 * @returns The validated, frozen call.
 * @throws If the fields break the part contract or are not a tool call.
 */
function parseToolCallPart(candidate: unknown): ToolCallReplyPart {
  const part = replyPartSchema.parse(candidate)
  if (part.kind !== "tool-call") throw new Error("Expected a tool call part")
  return Object.freeze(part)
}

/**
 * Owns the parts and the final state of one reply that is never stored or
 * shown, such as the tool keeper's reply to a search.
 *
 * @remarks Each operation follows the stored reply's contract: a reasoning
 * or text part gets a new UUIDv7, a tool call keeps its own identity, a
 * fragment is appended only to a reasoning or text part, and a tool call
 * changes only from the state the change follows. Invariant: once the
 * final state is kept, every write is refused, and so is a tool call of a
 * round at or past the reply's tool call round limit, which ends the reply
 * the way a deleted reply ends; reasoning and text of any round are kept.
 * Every part it keeps or returns is frozen, so a caller cannot change what
 * the reply keeps. Created per reply and dropped with it; holds no
 * resource. Concurrency model: single-owner, used by one reply on the
 * backend's event loop; each operation is one synchronous step.
 */
export default class MemoryReply {
  /** Number of rounds, from round 0, whose tool calls the reply keeps. */
  readonly #toolCallRoundCount: number

  /** Parts by identity, in the order they were created. */
  readonly #parts = new Map<string, ReplyPart>()

  /** Final state; `streaming` until it is kept. */
  #status: ConversationAssistantMessageStatus = "streaming"

  /**
   * Creates a streaming reply without parts.
   *
   * @param toolCallRoundCount - Number of rounds, from round 0, whose tool
   * calls the reply keeps; a positive integer.
   */
  public constructor(toolCallRoundCount: number) {
    this.#toolCallRoundCount = toolCallRoundCount
  }

  /**
   * Keeps a new part after the reply's last one.
   *
   * @param draft - The part; a reasoning or text part gets a new UUIDv7.
   * @returns The kept part with its identity and times, frozen; undefined
   * once the final state is kept, or for a tool call of a round at or past
   * the limit.
   * @throws If the draft breaks the part contract, such as empty text.
   */
  public createReplyPart(draft: ReplyPartDraft): ReplyPart | undefined {
    if (this.#status !== "streaming") return undefined
    if (draft.kind === "tool-call" && draft.round >= this.#toolCallRoundCount)
      return undefined
    const part = Object.freeze(buildReplyPart(draft, new Date().toISOString()))
    this.#parts.set(part.id, part)
    return part
  }

  /**
   * Appends a fragment to one of the reply's reasoning or text parts.
   *
   * @param partId - UUIDv7 of the part.
   * @param content - Non-empty fragment in stream order.
   * @returns The time kept as the part's `updatedAt`; undefined once the
   * final state is kept, or when the reply keeps no reasoning or text part
   * with the identity.
   * @throws If the fragment is empty, before anything changes.
   */
  public updateReplyPartContent(
    partId: string,
    content: string
  ): string | undefined {
    if (content.length === 0)
      throw new Error("Reply part fragment must not be empty")
    const part = this.#parts.get(partId)
    if (this.#status !== "streaming" || part === undefined) return undefined
    if (part.kind === "tool-call") return undefined
    const updatedAt = new Date().toISOString()
    const changed = replyPartSchema.parse({
      ...part,
      content: `${part.content}${content}`,
      updatedAt
    })
    this.#parts.set(partId, Object.freeze(changed))
    return updatedAt
  }

  /**
   * Keeps one change of one of the reply's tool calls.
   *
   * @param toolCallId - UUIDv7 of the call.
   * @param change - The call's next state.
   * @returns The call as kept, frozen; undefined once the final state is
   * kept, or when the reply keeps no tool call with the identity in the
   * state the change follows.
   * @throws If the changed call breaks the part contract, such as an empty
   * result.
   */
  public updateReplyToolCall(
    toolCallId: string,
    change: ReplyToolCallChange
  ): ToolCallReplyPart | undefined {
    const part = this.#parts.get(toolCallId)
    if (
      this.#status !== "streaming" ||
      part?.kind !== "tool-call" ||
      part.status !== getPreviousToolCallStatus(change)
    )
      return undefined
    const changed = buildChangedToolCall(part, change, new Date().toISOString())
    this.#parts.set(toolCallId, changed)
    return changed
  }

  /**
   * Keeps the reply's final state.
   *
   * @param completion - Completed with its finish reason, interrupted, or
   * failed.
   * @returns True when kept; false when a final state was kept before,
   * which changes nothing.
   */
  public updateAssistantMessageState(
    completion: AssistantMessageCompletion
  ): boolean {
    if (this.#status !== "streaming") return false
    this.#status = completion.status
    return true
  }

  /**
   * Reads the reply's state.
   *
   * @returns `streaming` until a final state is kept, then that state.
   */
  public findReplyStatus(): ConversationAssistantMessageStatus {
    return this.#status
  }
}
