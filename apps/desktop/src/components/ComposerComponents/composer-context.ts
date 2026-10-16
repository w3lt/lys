import type { ChatContextApiResponse } from "@lys/protocol"

import type { ChatContextMeasurementOutcome } from "@/lib/hooks/chatContextMeasurement"

/**
 * Context-window accounting for the composer meter, also used by the agent
 * editor's system-prompt measure.
 *
 * @remarks The backend measures what the next message would be sent with —
 * the agent's system prompt, the offered tool definitions, the stored
 * messages a turn includes, and the markup around the new message — with the
 * loaded model's tokenizer, and reports the context length the model is
 * loaded with. Only the draft's text is estimated here, from its length,
 * because it changes with every keystroke. Labels prefix counts with `~`
 * because the draft is estimated and the backend's counts include an
 * allowance for the chat template. Staged attachments are never sent, so they
 * are not part of the window. The agent editor uses only the text estimate
 * and the token-count format.
 */

/** Average characters per token used to estimate text length. */
const CHARACTERS_PER_TOKEN = 3.7

/** Estimated tokens per byte for an attached file's extracted text. */
const BYTES_PER_ATTACHMENT_TOKEN = 4

/** Meter before the first measurement settles; it carries no data. */
const MEASURING_CONTEXT_METER_STATE: ContextMeterState = Object.freeze({
  status: "measuring"
})

/** Meter for a model LM Studio has not loaded; it carries no data. */
const MODEL_NOT_LOADED_CONTEXT_METER_STATE: ContextMeterState = Object.freeze({
  status: "unknown",
  reason: "LM Studio has not loaded the model, so the window is unknown."
})

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

/** Breakdown of the context window the next message would take. */
export type ContextUsage = {
  /** Context length the model is loaded with, in tokens. */
  readonly contextLength: number
  /** Tokens held back for the reply, or zero when no ceiling is set. */
  readonly reserve: number
  /** Tokens of the answering agent's system prompt. */
  readonly systemPromptTokens: number
  /** Tokens of the offered tool definitions; zero when none are offered. */
  readonly toolTokens: number
  /** Tokens of the stored messages the next turn would include. */
  readonly historyTokens: number
  /** Number of stored messages the next turn would include. */
  readonly historyMessageCount: number
  /**
   * Tokens of the draft as it would be sent: the measured markup around the
   * new message plus the estimate of its text.
   */
  readonly messageTokens: number
  /** Tokens the request would take, without the reply reserve. */
  readonly usedTokens: number
  /** Tokens by which the request would exceed the window; zero when it fits. */
  readonly overflowTokens: number
  /** Tokens still available after the reserve; zero once the window is full. */
  readonly freeTokens: number
  /** Fraction of the window the request and the reserve take, at most `1`. */
  readonly filledFraction: number
}

/** What the composer knows about the window its next message would take. */
export type ContextMeterState =
  | {
      /** The first measurement has not settled yet. */
      readonly status: "measuring"
    }
  | {
      /** The window and what the next message would take of it. */
      readonly status: "measured"
      /** Measured parts, the draft's estimate, and what is left or over. */
      readonly usage: ContextUsage
    }
  | {
      /** The window could not be measured. */
      readonly status: "unknown"
      /** Caller-safe sentence saying why. */
      readonly reason: string
    }

/** Inputs of one context-window breakdown. */
export type ContextUsageInput = {
  /** The backend's measurement of everything but the draft. */
  readonly measurement: ChatContextApiResponse
  /** Composer draft; it is sent trimmed. */
  readonly draft: string
  /** Tokens reserved for the reply, or zero when no ceiling is set. */
  readonly reserve: number
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
 * Calculates the breakdown of the context window the next message would take.
 *
 * @param input - The backend's measurement, the draft, and the reply reserve.
 * @returns The measured parts, the draft's tokens, and what is left or over.
 * @remarks The rule matches the backend's check before every round: the
 * request fits while its tokens and the reserve together do not exceed the
 * context length.
 */
export function calculateContextUsage(input: ContextUsageInput): ContextUsage {
  const { measurement, reserve } = input
  const messageTokens =
    measurement.messageMarkupTokens + estimateTextTokens(input.draft.trim())
  const usedTokens =
    measurement.systemPromptTokens +
    measurement.toolTokens +
    measurement.historyTokens +
    messageTokens
  const requiredTokens = usedTokens + reserve

  return {
    contextLength: measurement.contextLength,
    reserve,
    systemPromptTokens: measurement.systemPromptTokens,
    toolTokens: measurement.toolTokens,
    historyTokens: measurement.historyTokens,
    historyMessageCount: measurement.historyMessageCount,
    messageTokens,
    usedTokens,
    overflowTokens: Math.max(0, requiredTokens - measurement.contextLength),
    freeTokens: Math.max(0, measurement.contextLength - requiredTokens),
    filledFraction: Math.min(1, requiredTokens / measurement.contextLength)
  }
}

/**
 * Builds what the meter shows from the latest measurement.
 *
 * @param outcome - Latest settled measurement, or undefined before the first.
 * @param input - Draft and reply reserve.
 * @returns `measuring` before the first measurement; `measured` with the
 * breakdown; or `unknown` with why, when the model is not loaded or the
 * measurement failed.
 */
export function buildContextMeterState(
  outcome: ChatContextMeasurementOutcome | undefined,
  input: Omit<ContextUsageInput, "measurement">
): ContextMeterState {
  if (outcome === undefined) return MEASURING_CONTEXT_METER_STATE
  switch (outcome.status) {
    case "measured":
      return {
        status: "measured",
        usage: calculateContextUsage({
          ...input,
          measurement: outcome.measurement
        })
      }
    case "model-not-loaded":
      return MODEL_NOT_LOADED_CONTEXT_METER_STATE
    case "failed":
      return { status: "unknown", reason: outcome.message }
  }
}
