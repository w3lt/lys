import type { ReplyContextMeasurement } from "./replyContextMeter"

/**
 * Failure that ends a reply because the model it names is not loaded, so the
 * next round's context cannot be measured against its window.
 *
 * @remarks Passive failure value constructed once per refused round. The
 * round is not sent, because LM Studio would load the model with settings Lys
 * does not know and could shorten a context that does not fit. It preserves
 * the native `Error` contract and owns no mutable state.
 */
export class ReplyModelNotLoadedError extends Error {
  /**
   * Creates the failure for one refused round.
   *
   * @param model - Identifier the turn names.
   */
  public constructor(model: string) {
    super(`The model "${model}" is not loaded`)
  }
}

/**
 * Failure that ends a reply because the next round does not fit the model's
 * context window.
 *
 * @remarks Passive failure value constructed once per refused round; the
 * round is not sent. It preserves the native `Error` contract, and its token
 * counts never change.
 */
export class ReplyContextOverflowError extends Error {
  /** Tokens the round needs: its context, tools, and reply reserve. */
  readonly #requiredTokens: number
  /** Context length the model is loaded with. */
  readonly #contextLength: number

  /**
   * Creates the failure for one refused round.
   *
   * @param requiredTokens - Tokens the round needs, greater than the window.
   * @param contextLength - Context length the model is loaded with.
   */
  public constructor(requiredTokens: number, contextLength: number) {
    super(
      `The reply needs ${requiredTokens} tokens and the model is loaded with ${contextLength}`
    )
    this.#requiredTokens = requiredTokens
    this.#contextLength = contextLength
  }

  /**
   * Tokens the refused round needs.
   *
   * @returns Its context, tools, and reply reserve together.
   */
  public get requiredTokens(): number {
    return this.#requiredTokens
  }

  /**
   * Context length of the model the round would have been sent to.
   *
   * @returns Tokens the model is loaded with.
   */
  public get contextLength(): number {
    return this.#contextLength
  }
}

/** Measurement and reply reserve of one round about to be sent. */
export type ReplyRoundContext = Readonly<{
  /** Measured context, or undefined when the model is not loaded. */
  measurement: ReplyContextMeasurement | undefined
  /** Identifier of the model the round is sent to. */
  model: string
  /**
   * Tokens held back for the reply: the reply ceiling, or 0 when the reply
   * has none.
   */
  reserveTokens: number
}>

/**
 * Calculates the tokens a measured request takes.
 *
 * @param measurement - Measured messages and offered tools.
 * @returns The sum of every message's tokens and the tools' tokens.
 */
export function calculateReplyContextTokens(
  measurement: ReplyContextMeasurement
): number {
  return measurement.messageTokenCounts.reduce(
    (total, messageTokens) => total + messageTokens,
    measurement.toolTokenCount
  )
}

/**
 * Finds why a round must not be sent.
 *
 * @param round - The round's measurement, model, and reply reserve.
 * @returns A {@link ReplyModelNotLoadedError} when there is no measurement,
 * a {@link ReplyContextOverflowError} when the context, tools, and reserve
 * together exceed the context length, and undefined when the round fits.
 * @remarks The rule matches the composer's context meter: a request that
 * takes exactly the whole window fits.
 */
export function findReplyRoundFitFailure(
  round: ReplyRoundContext
): ReplyModelNotLoadedError | ReplyContextOverflowError | undefined {
  const { measurement } = round
  if (measurement === undefined)
    return new ReplyModelNotLoadedError(round.model)
  const requiredTokens =
    calculateReplyContextTokens(measurement) + round.reserveTokens
  return requiredTokens > measurement.contextLength
    ? new ReplyContextOverflowError(requiredTokens, measurement.contextLength)
    : undefined
}

/**
 * Formats the sentence followers are sent when a reply fails.
 *
 * @param failure - Failure that ended the reply.
 * @returns For a round that did not fit, what it needed and the window, with
 * the next steps; for a model that is not loaded, how to load it; otherwise
 * the general sentence. No upstream or internal text is included.
 */
export function formatReplyFailureMessage(failure: unknown): string {
  if (failure instanceof ReplyContextOverflowError) {
    return `The conversation no longer fits the model's context window: the next request to the model needs ${formatTokenCount(failure.requiredTokens)} tokens, including the room kept for the reply, and the model is loaded with ${formatTokenCount(failure.contextLength)}. Start a new conversation, or load the model with a longer context in Settings → Model.`
  }
  if (failure instanceof ReplyModelNotLoadedError) {
    return "The model is not loaded, so Lys cannot check that the conversation fits it. Load the model in Settings → Model, then try again."
  }
  return "Chat completion failed. Please try again."
}

/**
 * Formats a token count for a sentence.
 *
 * @param tokenCount - Whole number of tokens.
 * @returns The count with comma thousands separators, such as `8,192`.
 */
function formatTokenCount(tokenCount: number): string {
  return tokenCount.toLocaleString("en-US")
}
