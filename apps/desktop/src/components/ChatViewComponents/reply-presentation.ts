import type {
  ConversationSource,
  ReplyPart,
  ToolCallReplyPart,
  ToolCallReplyPartStatus
} from "@lys/share"

import { CITATION_MARKER_PATTERN } from "../markdown-citations"

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
  calls: readonly ToolCallReplyPart[]
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

/** A stored tool call that has the result the model read. */
export type AnsweredToolCallReplyPart = Extract<
  ToolCallReplyPart,
  { status: "succeeded" | "failed" | "rejected" }
>

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
 * Builds the rounds of a reply from its parts, in stored order.
 *
 * @param parts - Parts whose rounds never decrease.
 * @returns Each round's parts, rounds in order.
 */
function buildReplyPartRounds(
  parts: readonly ReplyPart[]
): readonly (readonly ReplyPart[])[] {
  const rounds: ReplyPart[][] = []
  for (const part of parts) {
    const lastRound = rounds.at(-1)
    if (lastRound?.[0]?.round === part.round) lastRound.push(part)
    else rounds.push([part])
  }
  return rounds
}

/**
 * Builds the text a round wrote.
 *
 * @param parts - The round's parts.
 * @returns The content of its text parts, joined in order.
 */
function buildRoundText(parts: readonly ReplyPart[]): string {
  return parts
    .flatMap((part) => (part.kind === "text" ? [part.content] : []))
    .join("")
}

/**
 * Answers whether a part is a tool call.
 *
 * @param part - Part of a reply.
 * @returns True for a tool call.
 */
function isToolCallPart(part: ReplyPart): part is ToolCallReplyPart {
  return part.kind === "tool-call"
}

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
 * Answers whether a call has the result the model read.
 *
 * @param call - Stored call.
 * @returns True for a `succeeded`, `failed`, or `rejected` call.
 */
export function isAnsweredToolCall(
  call: ToolCallReplyPart
): call is AnsweredToolCallReplyPart {
  return (
    call.status === "succeeded" ||
    call.status === "failed" ||
    call.status === "rejected"
  )
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
  parts: readonly ReplyPart[],
  isStreaming: boolean
): ReplyPresentation {
  const rounds = buildReplyPartRounds(parts)
  const lastRound = rounds.at(-1) ?? []
  const isAnswerRound = !lastRound.some(isToolCallPart)
  const stepRounds = isAnswerRound ? rounds.slice(0, -1) : rounds
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
    answer: isAnswerRound ? buildRoundText(lastRound) : ""
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
 * Calculates the last moment a part shows the reply working.
 *
 * @param part - Stored part.
 * @returns Its update time in milliseconds since the epoch; for an
 * interrupted call, its creation time, because the reply's ending, not its
 * work, set the call's update time.
 */
function calculatePartWorkEnd(part: ReplyPart): number {
  const isInterruptedCall =
    part.kind === "tool-call" && part.status === "interrupted"
  return Date.parse(isInterruptedCall ? part.createdAt : part.updatedAt)
}

/**
 * Calculates how long an ended reply worked.
 *
 * @param reply - Times and parts of the reply.
 * @returns Milliseconds from its creation to the latest part's work end, as
 * {@link calculatePartWorkEnd} measures it; to its update time when it has
 * no parts. Time the reply spent waiting after its last part, such as while
 * Lys was closed before startup recovery interrupted it, is not counted.
 */
export function calculateReplyWorkDuration(reply: ReplyWorkTimes): number {
  const workEnd =
    reply.parts.length === 0
      ? Date.parse(reply.updatedAt)
      : Math.max(...reply.parts.map(calculatePartWorkEnd))
  return workEnd - Date.parse(reply.createdAt)
}

/**
 * Formats one argument value for display.
 *
 * @param value - Value parsed from the call's argument text.
 * @returns Text as it is; any other value as compact JSON.
 */
function formatArgumentValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value)
}

/**
 * Parses a call's argument text as a JSON object.
 *
 * @param argumentText - The model's argument text, which may be invalid.
 * @returns The object's entries in written order, or undefined when the text
 * is not a JSON object.
 */
function parseArgumentEntries(
  argumentText: string
): readonly (readonly [string, unknown])[] | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(argumentText)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return undefined
  return Object.entries(parsed)
}

/**
 * Parses a call's argument text into named values for display.
 *
 * @param argumentText - The model's argument text, which may be invalid.
 * @returns Each argument's name and displayed value in written order, or
 * undefined when the text is not a JSON object.
 */
export function parseToolCallArguments(
  argumentText: string
): readonly (readonly [string, string])[] | undefined {
  const entries = parseArgumentEntries(argumentText)
  if (entries === undefined) return undefined
  return Object.freeze(
    entries.map(([name, value]) => [name, formatArgumentValue(value)] as const)
  )
}

/**
 * Formats what a call is about, such as its query or address.
 *
 * @param call - Stored call.
 * @returns The value of its first text argument, or empty text when its
 * argument text is not a JSON object or has no text argument.
 */
export function formatToolCallTarget(call: ToolCallReplyPart): string {
  const target = parseArgumentEntries(call.argumentText)?.find(
    (entry): entry is readonly [string, string] => typeof entry[1] === "string"
  )
  return target?.[1] ?? ""
}

/**
 * Lists the source numbers text cites.
 *
 * @param text - Text written by the model.
 * @returns Each number in a `[n]` marker, once, in first-cited order.
 */
export function listCitedSourceNumbers(text: string): readonly number[] {
  const numbers = Array.from(text.matchAll(CITATION_MARKER_PATTERN), (match) =>
    Number(match[1])
  )
  return Object.freeze([...new Set(numbers)])
}

/**
 * Creates the sources listed under one reply.
 *
 * @param parts - The reply's parts.
 * @param answer - The reply's answer, as {@link createReplyPresentation}
 * lays it out; the text of its steps cites nothing, since it shows no links.
 * @param sources - Sources the reply may cite.
 * @returns The sources the answer cites, and those its succeeded calls
 * showed without being cited, each with the first tool that showed it.
 * Numbers without a source are left out.
 */
export function createReplySourcesPresentation(
  parts: readonly ReplyPart[],
  answer: string,
  sources: readonly ConversationSource[]
): ReplySourcesPresentation {
  const sourcesByNumber = new Map(
    sources.map((source) => [source.number, source])
  )
  const citedNumbers = listCitedSourceNumbers(answer)
  const cited = citedNumbers.flatMap((number) => {
    const source = sourcesByNumber.get(number)
    return source === undefined ? [] : [source]
  })
  const found = new Map<number, FoundSourcePresentation>()
  for (const call of parts.filter(isSucceededToolCallPart)) {
    for (const number of call.sourceNumbers) {
      const source = sourcesByNumber.get(number)
      if (source === undefined || citedNumbers.includes(number)) continue
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
 * Calculates the highest source number a reply's own calls showed.
 *
 * @param parts - The reply's parts.
 * @returns The highest number among its succeeded calls' sources; 0 when
 * they showed none.
 */
function calculateHighestShownSourceNumber(
  parts: readonly ReplyPart[]
): number {
  return Math.max(
    0,
    ...parts
      .filter(isSucceededToolCallPart)
      .flatMap((call) => call.sourceNumbers)
  )
}

/**
 * Calculates the highest source number each reply of a transcript may cite.
 *
 * @param messages - Transcript messages in conversation order.
 * @returns For each reply's identifier, the highest number its own calls or
 * an earlier reply's calls showed; 0 when none did. A conversation numbers
 * its sources in the order its calls show them, so a source above that
 * number was found by a later reply, which the reply could not have read.
 */
export function calculateReplySourceNumberLimits(
  messages: readonly ReplySourceScopeMessage[]
): ReadonlyMap<string, number> {
  const limits = new Map<string, number>()
  let limit = 0
  for (const message of messages) {
    if (message.role === "user") continue
    limit = Math.max(limit, calculateHighestShownSourceNumber(message.parts))
    limits.set(message.id, limit)
  }
  return limits
}

/**
 * Lists the sources one reply may cite.
 *
 * @param sources - The conversation's sources, in number order.
 * @param sourceNumberLimit - Highest number the reply may cite, as
 * {@link calculateReplySourceNumberLimits} gives it.
 * @returns The sources numbered up to the limit, in number order.
 */
export function listReplySources(
  sources: readonly ConversationSource[],
  sourceNumberLimit: number
): readonly ConversationSource[] {
  return Object.freeze(
    sources.filter((source) => source.number <= sourceNumberLimit)
  )
}
