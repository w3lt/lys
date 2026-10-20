import type {
  AnsweredToolCallReplyPart,
  ConversationAssistantMessageStatus,
  ConversationSource,
  ReplyPart,
  ToolCallReplyPart,
  ToolCallReplyPartStatus
} from "@lys/share"

import {
  buildReplyAnswer,
  buildReplyPartRounds,
  buildRoundText,
  isAnswerRound,
  isToolCallPart,
  type ChatViewReplyPart,
  type ChatViewToolCallReplyPart
} from "@/lib/store/chat-view/reply-parts"

/** What a reply's reasoning shows. */
export type ReplyReasoningPresentation = Readonly<{
  /** Every reasoning part's text, in order, separated by blank lines. */
  text: string
  /** Whether the reply is still streaming its reasoning. */
  isThinking: boolean
  /** Milliseconds the reply spent writing its reasoning parts. */
  durationMs: number
}>

/** One step of a reply: a model round that called tools. */
export type ReplyStepPresentation = Readonly<{
  /** Zero-based round of the step. */
  round: number
  /** Text the round wrote before its calls; empty when it wrote none. */
  text: string
  /** The round's calls in the model's order. */
  calls: readonly ChatViewToolCallReplyPart[]
}>

/** How one reply's parts are laid out. */
export type ReplyPresentation = Readonly<{
  /** The reply's reasoning, or undefined when it has none. */
  reasoning: ReplyReasoningPresentation | undefined
  /** Rounds that called tools, in order. */
  steps: readonly ReplyStepPresentation[]
  /**
   * Text of the reply's last round when that round called no tools; empty
   * otherwise. While the reply streams, this is the round being written.
   */
  answer: string
}>

/** A source one of the reply's calls showed that its text does not cite. */
export type FoundSourcePresentation = Readonly<{
  /** The numbered source. */
  source: ConversationSource
  /** Name of the first of the reply's tools that showed it. */
  toolName: string
}>

/** Sources listed under one reply. */
export type ReplySourcesPresentation = Readonly<{
  /** Sources the reply's answer cites, in the order it first cites them. */
  cited: readonly ConversationSource[]
  /** Sources the reply's calls showed and its answer does not cite. */
  found: readonly FoundSourcePresentation[]
}>

/** A stored tool call that ran and returned its output. */
type SucceededToolCallReplyPart = Extract<
  ToolCallReplyPart,
  { status: "succeeded" }
>

/** What source scoping reads of one transcript message. */
export type ReplySourceScopeMessage = Readonly<
  | {
      /** Identifier of the message. */
      id: string
      /** A user message, which shows no sources. */
      role: "user"
    }
  | {
      /** Identifier of the reply. */
      id: string
      /** An assistant reply. */
      role: "assistant"
      /** Lifecycle state of the reply, as the chat view shows it. */
      status: ConversationAssistantMessageStatus
      /** The reply's parts in stored order. */
      parts: readonly ReplyPart[]
    }
>

/** Times and parts of an ended reply, as its work time is measured. */
export type ReplyWorkTimes = Readonly<{
  /** Time the reply was created. */
  createdAt: string
  /** Time of the reply's latest state change. */
  updatedAt: string
  /** The reply's parts in stored order. */
  parts: readonly ReplyPart[]
}>

/**
 * Answers whether a part is a tool call that ran and returned its output.
 *
 * @param part - Part of a reply.
 * @returns True for a `succeeded` call, the only state that shows sources.
 */
function isSucceededToolCallPart(
  part: ReplyPart
): part is SucceededToolCallReplyPart {
  return part.kind === "tool-call" && part.status === "succeeded"
}

/**
 * Calculates the milliseconds one part was written over.
 *
 * @param part - Stored part.
 * @returns Its update time minus its creation time.
 */
function calculatePartDuration(part: ReplyPart): number {
  return Date.parse(part.updatedAt) - Date.parse(part.createdAt)
}

/**
 * Creates the presentation of a reply's reasoning.
 *
 * @param parts - The reply's parts.
 * @param isStreaming - Whether the reply still streams.
 * @returns The reasoning, or undefined when the reply has none.
 */
function createReasoningPresentation(
  parts: readonly ReplyPart[],
  isStreaming: boolean
): ReplyReasoningPresentation | undefined {
  const reasoningParts = parts.filter((part) => part.kind === "reasoning")
  if (reasoningParts.length === 0) return undefined
  return Object.freeze({
    text: reasoningParts.map((part) => part.content).join("\n\n"),
    isThinking: isStreaming && parts.at(-1)?.kind === "reasoning",
    durationMs: reasoningParts.reduce(
      (total, part) => total + calculatePartDuration(part),
      0
    )
  })
}

/**
 * Creates the layout of one reply from its parts.
 *
 * @param parts - The reply's parts in stored order.
 * @param isStreaming - Whether the reply still streams.
 * @returns The reasoning, the rounds that called tools as steps, and the last
 * round's text as the answer when that round called no tools.
 */
export function createReplyPresentation(
  parts: readonly ChatViewReplyPart[],
  isStreaming: boolean
): ReplyPresentation {
  const rounds = buildReplyPartRounds(parts)
  const stepRounds = isAnswerRound(rounds.at(-1) ?? [])
    ? rounds.slice(0, -1)
    : rounds
  return Object.freeze({
    reasoning: createReasoningPresentation(parts, isStreaming),
    steps: Object.freeze(
      stepRounds.map((roundParts) =>
        Object.freeze({
          round: roundParts[0]?.round ?? 0,
          text: buildRoundText(roundParts),
          calls: Object.freeze(roundParts.filter(isToolCallPart))
        })
      )
    ),
    answer: buildReplyAnswer(parts)
  })
}

/**
 * Formats a duration as whole seconds for a reply's summaries.
 *
 * @param durationMs - Duration in milliseconds.
 * @returns The rounded seconds, at least one, such as `12s`.
 */
export function formatReplyDuration(durationMs: number): string {
  return `${Math.max(1, Math.round(durationMs / 1000))}s`
}

/**
 * Formats the label of a reply's reasoning.
 *
 * @param reasoning - The reply's reasoning.
 * @returns `Thinking` while it streams, else how long it took.
 */
export function formatReasoningLabel(
  reasoning: ReplyReasoningPresentation
): string {
  return reasoning.isThinking
    ? "Thinking"
    : `Thought for ${formatReplyDuration(reasoning.durationMs)}`
}

/**
 * Formats a count with its noun.
 *
 * @param count - Non-negative count.
 * @param noun - Singular noun.
 * @returns Such as `1 step` or `3 steps`.
 */
function formatCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

/**
 * Formats the summary of a reply's steps.
 *
 * @param steps - The reply's steps.
 * @param workedMs - Milliseconds the ended reply took, or undefined while it
 * streams.
 * @returns Such as `Worked for 9s · 2 steps · 3 tool calls`.
 */
export function formatReplyStepsLabel(
  steps: readonly ReplyStepPresentation[],
  workedMs: number | undefined
): string {
  const callCount = steps.reduce((total, step) => total + step.calls.length, 0)
  const counts = `${formatCount(steps.length, "step")} · ${formatCount(callCount, "tool call")}`
  return workedMs === undefined
    ? counts
    : `Worked for ${formatReplyDuration(workedMs)} · ${counts}`
}

/**
 * Formats the accessible name of one of a reply's controls.
 *
 * @param label - The control's visible text.
 * @param replyNumber - One-based position of the reply among the
 * transcript's replies.
 * @returns The visible text, then the reply, such as `Thought for 3s,
 * reply 2`, so the same control of different replies has different names.
 */
export function formatReplyControlName(
  label: string,
  replyNumber: number
): string {
  return `${label}, reply ${replyNumber}`
}

/**
 * Formats the name of a tool call: its tool and what it is about.
 *
 * @param toolName - Name the model called; possibly empty.
 * @param target - What the call is about; possibly empty.
 * @returns Both, separated by a space, leaving out an empty one, such as
 * `web_search night moths`.
 */
export function formatToolCallName(toolName: string, target: string): string {
  return [toolName, target].filter((text) => text !== "").join(" ")
}

/**
 * Formats the outcome a reply announces once it has ended.
 *
 * @param status - The reply's lifecycle state.
 * @returns `Stopped` for an interrupted reply and `Failed` for a failed one;
 * undefined for a reply that streams or completed, which announces no
 * outcome.
 */
export function formatReplyOutcome(
  status: ConversationAssistantMessageStatus
): string | undefined {
  switch (status) {
    case "interrupted":
      return "Stopped"
    case "failed":
      return "Failed"
    case "streaming":
    case "completed":
      return undefined
  }
}

/**
 * Formats the state of a tool call for the person.
 *
 * @param status - The call's stored state.
 * @returns A short label.
 */
export function formatToolCallStatus(status: ToolCallReplyPartStatus): string {
  switch (status) {
    case "awaiting-approval":
      return "Waiting for approval"
    case "running":
      return "Running"
    case "succeeded":
      return "Done"
    case "failed":
      return "Failed"
    case "rejected":
      return "Rejected"
    case "interrupted":
      return "Stopped"
  }
}

/**
 * Formats the summary of the sources a reply's calls found without citing.
 *
 * @param sources - The reply's cited and found sources.
 * @returns `N more` when the reply cites sources; otherwise
 * `Sources · N found`, which names the list on its own.
 */
export function formatFoundSourcesLabel(
  sources: ReplySourcesPresentation
): string {
  const count = sources.found.length
  return sources.cited.length > 0 ? `${count} more` : `Sources · ${count} found`
}

/**
 * Formats the label of a call's result.
 *
 * @param call - Stored call with a result.
 * @returns `Rejection` for a rejected call, else `Result`.
 */
export function formatToolCallResultLabel(
  call: AnsweredToolCallReplyPart
): string {
  return call.status === "rejected" ? "Rejection" : "Result"
}

/**
 * Calculates how long an ended reply worked.
 *
 * @param reply - Times and parts of the reply.
 * @returns Milliseconds from its creation to the latest update time of any
 * of its parts, whichever part that is; to its own update time when it has
 * no parts. A call that waited for the person counts until it was answered,
 * or until the reply was stopped while it waited. Time after the last
 * part's update, such as while Lys was closed before startup recovery
 * interrupted the reply, is not counted: recovery keeps each open call's
 * update time.
 */
export function calculateReplyWorkDuration(reply: ReplyWorkTimes): number {
  const workEnd =
    reply.parts.length === 0
      ? Date.parse(reply.updatedAt)
      : Math.max(...reply.parts.map((part) => Date.parse(part.updatedAt)))
  return workEnd - Date.parse(reply.createdAt)
}

/**
 * Creates the sources listed under one reply.
 *
 * @param parts - The reply's parts.
 * @param citedNumbers - Numbers its answer's prose cites, in first-cited
 * order, as the store lists them; the text of its steps cites nothing, since
 * it shows no links.
 * @param sources - Sources the reply may cite, as {@link listReplySources}
 * lists them.
 * @returns The sources the answer cites, which its citation links open, and
 * those its succeeded calls showed without being cited, each with the first
 * tool that showed it. A cited number the reply may not cite is left out,
 * since its marker is no link.
 */
export function createReplySourcesPresentation(
  parts: readonly ReplyPart[],
  citedNumbers: readonly number[],
  sources: readonly ConversationSource[]
): ReplySourcesPresentation {
  const sourcesByNumber = new Map(
    sources.map((source) => [source.number, source])
  )
  const cited = citedNumbers.flatMap((number) => {
    const source = sourcesByNumber.get(number)
    return source === undefined ? [] : [source]
  })
  const citedSourceNumbers = new Set(cited.map((source) => source.number))
  const found = new Map<number, FoundSourcePresentation>()
  for (const call of parts.filter(isSucceededToolCallPart)) {
    for (const number of call.sourceNumbers) {
      const source = sourcesByNumber.get(number)
      if (source === undefined || citedSourceNumbers.has(number)) continue
      if (!found.has(number))
        found.set(number, Object.freeze({ source, toolName: call.toolName }))
    }
  }
  return Object.freeze({
    cited: Object.freeze(cited),
    found: Object.freeze([...found.values()])
  })
}

/**
 * Lists the source numbers a reply's own calls showed.
 *
 * @param parts - The reply's parts.
 * @returns The numbers its succeeded calls' results show, in call order;
 * a number may repeat.
 */
function listShownSourceNumbers(
  parts: readonly ReplyPart[]
): readonly number[] {
  return parts
    .filter(isSucceededToolCallPart)
    .flatMap((call) => call.sourceNumbers)
}

/**
 * Answers whether the backend sends a reply in this state to the model of
 * later turns.
 *
 * @param status - Lifecycle state of a reply, as the chat view shows it.
 * @returns True for `completed` and `interrupted`, whose answered calls and
 * results later turns read; false for `failed`, which is left out of later
 * turns, and for `streaming`, the turn still being written.
 */
function isContextReplyStatus(
  status: ConversationAssistantMessageStatus
): boolean {
  switch (status) {
    case "completed":
    case "interrupted":
      return true
    case "failed":
    case "streaming":
      return false
  }
}

/**
 * Calculates the source numbers each reply of a transcript may cite: those
 * its model read.
 *
 * @param messages - Transcript messages in conversation order.
 * @returns For each reply's identifier, the numbers its own succeeded calls
 * showed, together with those the succeeded calls of earlier completed or
 * interrupted replies showed, which the backend sends to the model as
 * context. A failed reply is left out of later turns, so the sources only it
 * showed stay its own; a later reply's sources were found after the reply.
 */
export function calculateReplyCitableSourceNumbers(
  messages: readonly ReplySourceScopeMessage[]
): ReadonlyMap<string, ReadonlySet<number>> {
  const citableNumbers = new Map<string, ReadonlySet<number>>()
  const contextNumbers = new Set<number>()
  for (const message of messages) {
    if (message.role === "user") continue
    const shownNumbers = listShownSourceNumbers(message.parts)
    citableNumbers.set(
      message.id,
      new Set([...contextNumbers, ...shownNumbers])
    )
    if (!isContextReplyStatus(message.status)) continue
    for (const number of shownNumbers) contextNumbers.add(number)
  }
  return citableNumbers
}

/**
 * Lists the sources one reply may cite.
 *
 * @param sources - The conversation's sources, in number order.
 * @param citableNumbers - Numbers the reply may cite, as
 * {@link calculateReplyCitableSourceNumbers} gives them.
 * @returns The sources with those numbers, in number order, keeping each
 * source object, so the list holds the same objects while the reply's
 * sources stay the same.
 */
export function listReplySources(
  sources: readonly ConversationSource[],
  citableNumbers: ReadonlySet<number>
): readonly ConversationSource[] {
  return Object.freeze(
    sources.filter((source) => citableNumbers.has(source.number))
  )
}
