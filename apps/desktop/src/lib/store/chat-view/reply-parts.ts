import type { ReplyPart, ToolCallReplyPart } from "@lys/share"

import { listProseCitationNumbers } from "@/lib/citation-markers"

/** A tool call's arguments as the chat view shows them. */
export type ToolCallArgumentsView = Readonly<{
  /**
   * Value of the first text argument, such as a query or an address; empty
   * when the argument text is not a JSON object or has no text argument.
   */
  target: string
  /**
   * Each argument's name and displayed value in written order: text as it
   * is, any other value as compact JSON; undefined when the argument text is
   * not a JSON object.
   */
  entries: readonly (readonly [string, string])[] | undefined
}>

/**
 * A tool call of a reply as the chat view holds it: the stored call and its
 * arguments, parsed once when the call entered the store.
 */
export type ChatViewToolCallReplyPart = ToolCallReplyPart &
  Readonly<{
    /** The call's arguments as {@link buildChatViewReplyPart} parsed them. */
    argumentsView: ToolCallArgumentsView
  }>

/** One part of a reply as the chat view holds it. */
export type ChatViewReplyPart =
  Exclude<ReplyPart, { kind: "tool-call" }> | ChatViewToolCallReplyPart

/** Arguments of a call whose argument text is not a JSON object. */
const UNSTRUCTURED_ARGUMENTS_VIEW: ToolCallArgumentsView = Object.freeze({
  target: "",
  entries: undefined
})

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
 * Parses a call's argument text into the view the chat view shows.
 *
 * @param argumentText - The model's argument text, which may be invalid.
 * @returns The call's target and named values; no target and no entries
 * when the text is not a JSON object.
 */
export function parseToolCallArgumentsView(
  argumentText: string
): ToolCallArgumentsView {
  const entries = parseArgumentEntries(argumentText)
  if (entries === undefined) return UNSTRUCTURED_ARGUMENTS_VIEW
  const target = entries.find(
    (entry): entry is readonly [string, string] => typeof entry[1] === "string"
  )
  return Object.freeze({
    target: target?.[1] ?? "",
    entries: Object.freeze(
      entries.map(([name, value]) =>
        Object.freeze([name, formatArgumentValue(value)] as const)
      )
    )
  })
}

/**
 * Builds the chat view's copy of one stored part.
 *
 * @param part - Protocol- or schema-validated part, as the backend stored it.
 * @returns A frozen copy; a tool call also carries its parsed arguments, so
 * rendering never parses the model's argument text.
 */
export function buildChatViewReplyPart(part: ReplyPart): ChatViewReplyPart {
  if (part.kind !== "tool-call") return Object.freeze({ ...part })
  return Object.freeze({
    ...part,
    argumentsView: parseToolCallArgumentsView(part.argumentText)
  })
}

/**
 * Answers whether a part is a tool call.
 *
 * @param part - Part of a reply, as the chat view holds it.
 * @returns True for a tool call.
 */
export function isToolCallPart(
  part: ChatViewReplyPart
): part is ChatViewToolCallReplyPart {
  return part.kind === "tool-call"
}

/**
 * Builds the rounds of a reply from its parts, in stored order.
 *
 * @param parts - Parts whose rounds never decrease.
 * @returns Each round's parts, rounds in order.
 */
export function buildReplyPartRounds(
  parts: readonly ChatViewReplyPart[]
): readonly (readonly ChatViewReplyPart[])[] {
  const rounds: ChatViewReplyPart[][] = []
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
export function buildRoundText(parts: readonly ChatViewReplyPart[]): string {
  return parts
    .flatMap((part) => (part.kind === "text" ? [part.content] : []))
    .join("")
}

/**
 * Answers whether a round answers the person rather than taking a step.
 *
 * @param parts - The round's parts; empty for a reply with no parts.
 * @returns True when the round called no tools.
 */
export function isAnswerRound(parts: readonly ChatViewReplyPart[]): boolean {
  return !parts.some(isToolCallPart)
}

/**
 * Builds the answer of a reply.
 *
 * @param parts - The reply's parts in stored order.
 * @returns The text of its last round when that round called no tools;
 * empty otherwise. While the reply streams, this is the round being written.
 */
export function buildReplyAnswer(parts: readonly ChatViewReplyPart[]): string {
  const lastRound = buildReplyPartRounds(parts).at(-1) ?? []
  return isAnswerRound(lastRound) ? buildRoundText(lastRound) : ""
}

/**
 * Lists the source numbers a reply's answer cites.
 *
 * @param parts - The reply's parts in stored order.
 * @returns The numbers {@link listProseCitationNumbers} finds in
 * {@link buildReplyAnswer}'s text: those of the markers in its prose, which
 * the reply links when it may cite them.
 */
export function listAnswerCitationNumbers(
  parts: readonly ChatViewReplyPart[]
): readonly number[] {
  return listProseCitationNumbers(buildReplyAnswer(parts))
}
