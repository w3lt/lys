import type { ChatGenerationEvent } from "@lys/protocol"
import type { FastifyBaseLogger } from "fastify"
import type { TitleGenerationOptions } from "./chatService"
import { waitForSettlementOrAbort } from "../../utils/abort"
import { TitleGenerationOutputError } from "../../utils/errors"

/** Inputs, attempt limit, and callbacks for one title-generation task. */
export type CreateTitleGenerationTaskOptions = {
  /** Starts one external title request, borrowing the application adapter. */
  generateTitle: (options: TitleGenerationOptions) => Promise<string>
  /**
   * Observes the context length a model is loaded with, through the
   * model-operation queue; resolves to undefined when the model is not
   * loaded, and rejects when the runtime cannot be reached or is busy. It
   * never loads the model. Completion-only: the queue keeps an accepted
   * observation until it settles.
   */
  findLoadedContextLength: (model: string) => Promise<number | undefined>
  /** User content used as the title-generation prompt. */
  userMessageContent: string
  /** Model identifier passed to the chat service. */
  model: string
  /** Signal owned by the generation and aborted only at backend shutdown. */
  abortSignal: AbortSignal
  /** Queues the title event for every stream following the turn; never waits. */
  sendEvent: (event: ChatGenerationEvent) => void
  /** Request-scoped logger that receives title-generation outcomes. */
  logger: FastifyBaseLogger
  /** Positive, inclusive maximum number of title requests validated by the backend configuration. */
  titleGenerationMaxAttempts: number
  /** Conditional first-title assignment returning the saved title, or `undefined` after a rename, competing assignment, or deletion. */
  updateConversationTitle: (title: string) => string | undefined
}

/** Inputs used to request a title within the attempt limit. */
type TitleGenerationAttemptOptions = Pick<
  CreateTitleGenerationTaskOptions,
  | "generateTitle"
  | "findLoadedContextLength"
  | "userMessageContent"
  | "model"
  | "abortSignal"
  | "logger"
  | "titleGenerationMaxAttempts"
>

/** Event sender, logger, and persistence callback used for a generated title. */
type GeneratedTitleHandlingOptions = Pick<
  CreateTitleGenerationTaskOptions,
  "sendEvent" | "logger" | "updateConversationTitle"
>

/** Outcome of requesting a title within the attempt limit. */
type TitleGenerationResult =
  | {
      /** A usable title was generated. */
      readonly status: "generated"
      /** Trimmed, non-empty generated title. */
      readonly title: string
      /** Title requests made, including the successful one. */
      readonly attempts: number
    }
  | {
      /** Shutdown cancelled title generation, so no further title request is made. */
      readonly status: "abandoned"
      /** Title requests made before the cancellation was observed. */
      readonly attempts: number
      /** Failure of the cancelled request, or the abort reason when none was made. */
      readonly error: unknown
    }
  | {
      /** The model is not loaded, so no further title request is made. */
      readonly status: "model-not-loaded"
      /** Title requests made before the model was observed as not loaded. */
      readonly attempts: number
    }
  | {
      /** Title generation ended without a usable title. */
      readonly status: "failed"
      /** Title requests made. */
      readonly attempts: number
      /** Unusable output from the last permitted request, or a failure that is not retried. */
      readonly error: unknown
    }

/** Title-generation result that carries a usable title. */
type GeneratedTitle = Extract<TitleGenerationResult, { status: "generated" }>

/**
 * Generates a title for a conversation without a stored title and reports the
 * outcome.
 *
 * Titles are requested up to `titleGenerationMaxAttempts` times; only a reply
 * unusable as a title consumes another request. Before each request the
 * model is checked to be loaded, and no request is sent when it is not, so a
 * title request never makes LM Studio load the model with its own settings.
 * A model unloaded between that check and the request can still be loaded
 * by LM Studio. A generated title is persisted only while the conversation
 * remains untitled, before one `title` event is sent to the turn's
 * followers. If the conversation was renamed or deleted first, this task
 * preserves the stored state and sends no event. Other
 * unsuccessful outcomes leave this task's candidate unsaved; a turn that
 * starts after this task settles retries if the conversation is still
 * untitled. Stopping the reply does not cancel this task; only backend
 * shutdown does. Retries and unsuccessful outcomes are logged with
 * `titleGenerationOutcome` and `titleGenerationAttempts` fields, plus `err`
 * for the failure or abort reason behind them: `retrying` at debug level
 * before each further request; `title-not-generated` at warn level after
 * exhausted attempts, a failure that is not retried, or a failed loaded
 * check; `model-not-loaded` at debug level, without `err`, when the model is
 * not loaded; `abandoned` at debug level after a shutdown cancellation,
 * including one during the loaded check; `already-titled` at debug level,
 * without `err`, when the conversation was renamed or deleted first; and
 * `title-not-saved` at error level after a persistence failure. The task
 * never sends an `error` event.
 *
 * @param options - Title generator, loaded check, prompt input, attempt
 * limit, cancellation signal, event sender, logger, and title persistence
 * callback.
 * @returns A promise that resolves after the title is sent or the outcome is
 * logged; it does not reject.
 */
export default async function createTitleGenerationTask(
  options: CreateTitleGenerationTaskOptions
): Promise<void> {
  const titleGeneration = await generateTitleWithinAttempts(options)
  const { logger } = options

  switch (titleGeneration.status) {
    case "generated":
      handleGeneratedTitle(options, titleGeneration)
      return
    case "model-not-loaded":
      logger.debug(
        {
          titleGenerationOutcome: "model-not-loaded",
          titleGenerationAttempts: titleGeneration.attempts
        },
        "Title generation skipped because the model is not loaded"
      )
      return
    case "abandoned":
      logger.debug(
        {
          err: titleGeneration.error,
          titleGenerationOutcome: "abandoned",
          titleGenerationAttempts: titleGeneration.attempts
        },
        "Title generation stopped because the backend is shutting down"
      )
      return
    case "failed":
      logger.warn(
        {
          err: titleGeneration.error,
          titleGenerationOutcome: "title-not-generated",
          titleGenerationAttempts: titleGeneration.attempts
        },
        "Title generation failed; this task saved no title"
      )
      return
  }
}

/**
 * Requests a title until one is usable, the attempt limit is reached, the
 * model is not loaded, or shutdown cancels it.
 *
 * @remarks Only {@link TitleGenerationOutputError} consumes another attempt.
 * HTTP, connection, and cancellation failures end generation at once; within
 * the failed attempt, the OpenAI SDK has already retried connection failures,
 * timeouts, and 408, 409, 429, and 5xx responses. Each request follows a
 * loaded check.
 * @param options - Title generator, loaded check, prompt input, signal,
 * logger, and attempt limit.
 * @returns A promise that resolves to the generation result; it does not reject.
 */
async function generateTitleWithinAttempts(
  options: TitleGenerationAttemptOptions
): Promise<TitleGenerationResult> {
  const {
    generateTitle,
    userMessageContent,
    model,
    abortSignal,
    logger,
    titleGenerationMaxAttempts
  } = options
  let attempts = 0

  while (true) {
    const unsentResult = await findUnsentTitleResult(options, attempts)
    if (unsentResult !== undefined) return unsentResult

    attempts += 1
    try {
      const title = await generateTitle({
        message: userMessageContent,
        model,
        signal: abortSignal
      })
      return { status: "generated", title, attempts }
    } catch (error) {
      if (abortSignal.aborted) {
        return { status: "abandoned", attempts, error }
      }

      // `attempts < limit` is false for a limit that is not a number, so an
      // invalid limit ends generation instead of requesting titles forever.
      const canRequestAnotherTitle =
        error instanceof TitleGenerationOutputError &&
        attempts < titleGenerationMaxAttempts
      if (!canRequestAnotherTitle) {
        return { status: "failed", attempts, error }
      }

      logger.debug(
        {
          err: error,
          titleGenerationOutcome: "retrying",
          titleGenerationAttempts: attempts
        },
        "Generated title was unusable; requesting another"
      )
    }
  }
}

/**
 * Checks that a title request may be sent: the task is not cancelled and the
 * model is loaded.
 *
 * @param options - Loaded check, model, and shutdown signal.
 * @param attempts - Title requests made so far.
 * @returns Undefined when the request may be sent; otherwise the result that
 * ends generation: abandoned on shutdown, including during the check,
 * model-not-loaded, or failed when the check fails.
 * @remarks Shutdown ends the wait for the check at once; the queue still
 * completes a check it accepted, and its outcome is ignored.
 */
async function findUnsentTitleResult(
  {
    findLoadedContextLength,
    model,
    abortSignal
  }: Pick<
    TitleGenerationAttemptOptions,
    "findLoadedContextLength" | "model" | "abortSignal"
  >,
  attempts: number
): Promise<TitleGenerationResult | undefined> {
  if (abortSignal.aborted) {
    return { status: "abandoned", attempts, error: abortSignal.reason }
  }
  try {
    const contextLength = await waitForSettlementOrAbort(
      findLoadedContextLength(model),
      abortSignal
    )
    return contextLength === undefined
      ? { status: "model-not-loaded", attempts }
      : undefined
  } catch (error) {
    return abortSignal.aborted
      ? { status: "abandoned", attempts, error }
      : { status: "failed", attempts, error }
  }
}

/**
 * Assigns a generated title and sends it only when this task wins persistence.
 *
 * @param options - Event sender, logger, and persistence callback.
 * @param generatedTitle - Usable title and the requests made to generate it.
 * @remarks Only a successful assignment sends one `title` event to the
 * turn's followers; every other outcome is logged by
 * {@link saveGeneratedTitle}. It does not throw.
 */
function handleGeneratedTitle(
  options: GeneratedTitleHandlingOptions,
  generatedTitle: GeneratedTitle
): void {
  const persistedTitle = saveGeneratedTitle(options, generatedTitle)
  if (persistedTitle !== undefined)
    options.sendEvent({ type: "title", title: persistedTitle })
}

/**
 * Saves a generated title while the conversation is still untitled.
 *
 * @param options - Logger and persistence callback.
 * @param generatedTitle - Usable title and the requests made to generate it.
 * @returns The saved title, or undefined when the conversation was renamed or
 * deleted first or the write failed, each logged as
 * {@link createTitleGenerationTask} describes.
 */
function saveGeneratedTitle(
  {
    logger,
    updateConversationTitle
  }: Pick<GeneratedTitleHandlingOptions, "logger" | "updateConversationTitle">,
  { title, attempts }: GeneratedTitle
): string | undefined {
  try {
    const persistedTitle = updateConversationTitle(title)
    if (persistedTitle === undefined) {
      logger.debug(
        {
          titleGenerationOutcome: "already-titled",
          titleGenerationAttempts: attempts
        },
        "The conversation was renamed or deleted before the title was saved"
      )
    }
    return persistedTitle
  } catch (error) {
    logger.error(
      {
        err: error,
        titleGenerationOutcome: "title-not-saved",
        titleGenerationAttempts: attempts
      },
      "Generated title could not be saved"
    )
    return undefined
  }
}
