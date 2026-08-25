/**
 * Context-window accounting for the composer meter.
 *
 * @remarks Every value produced here is a client-side estimate. The backend
 * does not report token counts, so the meter describes what the composer
 * believes it would send rather than what a tokenizer measured. Labels in the
 * composer prefix these values with `~` for that reason.
 */

/** Average characters per token used to estimate text length. */
const CHARACTERS_PER_TOKEN = 3.7

/** Estimated tokens spent on the backend-assembled system preamble. */
const SYSTEM_PREAMBLE_TOKENS = 96

/** Share of a compacted stretch of conversation that its recap still costs. */
const RECAP_RATIO = 0.16

/** Smallest recap the estimator will bill for a non-empty compacted stretch. */
const MINIMUM_RECAP_TOKENS = 48

/** Estimated tokens per byte for an attached file's extracted text. */
const BYTES_PER_ATTACHMENT_TOKEN = 4

/** One conversation turn measured by the context estimator. */
export type ContextTurn = {
  /** Stable identifier used to mark the turn kept, cut, or compacted. */
  readonly id: string
  /** Turn text whose length drives the estimate. */
  readonly text: string
}

/** One file staged in the composer's context tray. */
export type ComposerAttachment = {
  /** Stable identifier assigned when the file was staged. */
  readonly id: string
  /** File name shown on the chip. */
  readonly name: string
  /** Lowercase extension shown as the chip's kind marker, without a dot. */
  readonly kind: string
  /** Estimated tokens this file would occupy in the window. */
  readonly estimatedTokens: number
}

/** Complete estimated breakdown of one context window. */
export type ContextUsage = {
  /** Total window size in tokens. */
  readonly budget: number
  /** Tokens held back for the reply, or zero when no ceiling is set. */
  readonly reserve: number
  /** Tokens attributed to the backend preamble. */
  readonly systemTokens: number
  /** Tokens attributed to staged attachments. */
  readonly attachmentTokens: number
  /** Tokens attributed to the recap standing in for compacted turns. */
  readonly recapTokens: number
  /** Tokens attributed to turns sent verbatim. */
  readonly keptTokens: number
  /** Estimated tokens occupied in total, excluding the reply reserve. */
  readonly usedTokens: number
  /** Tokens by which the request would exceed the window; zero when it fits. */
  readonly overflowTokens: number
  /** Tokens still available after the reserve; zero once the window is full. */
  readonly freeTokens: number
  /** Number of turns sent verbatim. */
  readonly keptTurnCount: number
  /** Number of turns folded into the recap. */
  readonly compactedTurnCount: number
  /** Identifiers of the turns sent verbatim. */
  readonly keptTurnIds: ReadonlySet<string>
  /** Fraction of the window consumed, clamped to `1`. */
  readonly filledFraction: number
}

/** Result of one reverse walk over the turns that fit a given space. */
type ContextWalkResult = {
  /** Identifiers of the turns that fit verbatim. */
  readonly keptTurnIds: ReadonlySet<string>
  /** Estimated tokens spent on turns kept verbatim. */
  readonly keptTokens: number
  /** Number of turns kept verbatim. */
  readonly keptTurnCount: number
  /** Number of turns that did not fit. */
  readonly compactedTurnCount: number
  /** Estimated tokens of the turns that did not fit, before recapping. */
  readonly compactedTokens: number
}

/** Inputs required to estimate one context window. */
export type ContextUsageInput = {
  /** Context-window size in tokens, from the persisted model settings. */
  readonly budget: number
  /** Tokens reserved for the reply, or zero when no ceiling is set. */
  readonly reserve: number
  /** Turns in display order, oldest first. */
  readonly turns: readonly ContextTurn[]
  /** Files staged in the composer's context tray. */
  readonly attachments: readonly ComposerAttachment[]
}

/**
 * Estimates the token count of a stretch of text.
 *
 * @param text - Text to measure; an empty string costs zero tokens.
 * @returns The estimated token count, rounded up.
 */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / CHARACTERS_PER_TOKEN)
}

/**
 * Estimates the token count of an attached file from its byte length.
 *
 * @param sizeBytes - File size in bytes.
 * @returns The estimated token count, at least one.
 */
export function estimateAttachmentTokens(sizeBytes: number): number {
  return Math.max(1, Math.ceil(sizeBytes / BYTES_PER_ATTACHMENT_TOKEN))
}

/**
 * Formats a token count for a compact meter or chip label.
 *
 * @param tokenCount - Count to format; values below one thousand are exact.
 * @returns A short label such as `812`, `4.1k`, or `16k`.
 */
export function formatTokenCount(tokenCount: number): string {
  if (tokenCount < 1000) return String(Math.round(tokenCount))

  return `${(tokenCount / 1000).toFixed(tokenCount >= 10_000 ? 0 : 1)}k`
}

/**
 * Estimates the tokens one turn occupies.
 *
 * @param turn - Turn whose text is measured.
 * @returns The estimated token count for the turn.
 */
function estimateTurnTokens(turn: ContextTurn): number {
  return estimateTextTokens(turn.text)
}

/**
 * Walks turns newest to oldest, keeping those that fit the supplied space.
 *
 * @param turns - Turns in display order, oldest first.
 * @param space - Tokens available for verbatim turns.
 * @returns Which turns fit verbatim and what the remainder would cost.
 * @remarks Once one turn fails to fit, every older turn is compacted even if it
 * would have fit on its own; the window has to stay contiguous from the newest
 * turn backwards.
 */
function walkTurnsWithinSpace(
  turns: readonly ContextTurn[],
  space: number
): ContextWalkResult {
  const keptTurnIds = new Set<string>()
  let keptTokens = 0
  let keptTurnCount = 0
  let compactedTurnCount = 0
  let compactedTokens = 0
  let isFull = false

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]
    const turnTokens = estimateTurnTokens(turn)

    if (!isFull && keptTokens + turnTokens <= space) {
      keptTokens += turnTokens
      keptTurnCount += 1
      keptTurnIds.add(turn.id)
      continue
    }

    isFull = true
    compactedTurnCount += 1
    compactedTokens += turnTokens
  }

  return {
    keptTurnIds,
    keptTokens,
    keptTurnCount,
    compactedTurnCount,
    compactedTokens
  }
}

/**
 * Estimates what a recap of the compacted turns would cost.
 *
 * @param compactedTokens - Estimated tokens of the turns being replaced.
 * @returns The recap's estimated token count, or zero when nothing compacted.
 */
function estimateRecapTokens(compactedTokens: number): number {
  if (compactedTokens === 0) return 0

  return Math.max(
    MINIMUM_RECAP_TOKENS,
    Math.round(compactedTokens * RECAP_RATIO)
  )
}

/**
 * Estimates the complete breakdown of one context window.
 *
 * @param input - Window size, reply reserve, turns, and staged attachments.
 * @returns The estimated breakdown rendered by the composer's context meter.
 * @remarks The recap occupies the window it is summarizing, so the turns are
 * walked twice: once to discover what overflows, and again against the space
 * left after paying for that recap. Attachments are billed in full and are
 * never compacted, so a single large file can push the request over the window
 * on its own.
 */
export function calculateContextUsage(input: ContextUsageInput): ContextUsage {
  const { budget, reserve, turns, attachments } = input
  const attachmentTokens = attachments.reduce(
    (total, attachment) => total + attachment.estimatedTokens,
    0
  )
  const room = Math.max(
    0,
    budget - reserve - SYSTEM_PREAMBLE_TOKENS - attachmentTokens
  )

  let walk = walkTurnsWithinSpace(turns, room)
  let recapTokens = estimateRecapTokens(walk.compactedTokens)
  if (recapTokens > 0) {
    walk = walkTurnsWithinSpace(turns, Math.max(0, room - recapTokens))
    recapTokens = estimateRecapTokens(walk.compactedTokens)
  }

  const usedTokens =
    SYSTEM_PREAMBLE_TOKENS + attachmentTokens + recapTokens + walk.keptTokens

  return {
    budget,
    reserve,
    systemTokens: SYSTEM_PREAMBLE_TOKENS,
    attachmentTokens,
    recapTokens,
    keptTokens: walk.keptTokens,
    usedTokens,
    overflowTokens: Math.max(0, usedTokens + reserve - budget),
    freeTokens: Math.max(0, budget - reserve - usedTokens),
    keptTurnCount: walk.keptTurnCount,
    compactedTurnCount: walk.compactedTurnCount,
    keptTurnIds: walk.keptTurnIds,
    filledFraction: Math.min(1, (usedTokens + reserve) / budget)
  }
}
