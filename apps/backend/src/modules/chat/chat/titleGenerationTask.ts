import type { FastifyBaseLogger } from "fastify"
import type ChatService from "../../../di/services/chatService"
import { TitleGenerationOutputError } from "../../../utils/errors"
import { createEventSender, type ChatRouteReply } from "./share"

/** Inputs, attempt limit, and callbacks for one title-generation task. */
type CreateTitleGenerationTaskOptions = {
  /** Application-scoped service used to generate the title. */
  chatService: ChatService
  /** User content used as the title-generation prompt. */
  userMessageContent: string
  /** Model identifier passed to the chat service. */
  model: string
  /** Signal owned by the route and aborted when the SSE client disconnects. */
  abortSignal: AbortSignal
  /** Reply whose SSE connection receives the title event. */
  reply: ChatRouteReply
  /** Request-scoped logger that receives title-generation outcomes. */
  logger: FastifyBaseLogger
  /** Validated positive, inclusive maximum number of title requests. */
  titleGenerationMaxAttempts: number
  /** Synchronous persistence callback run before the title event is sent. */
  updateConversationTitle: (title: string) => void
}

/** Inputs used to request a title within the attempt limit. */
type TitleGenerationAttemptOptions = Pick<
  CreateTitleGenerationTaskOptions,
  | "chatService"
  | "userMessageContent"
  | "model"
  | "abortSignal"
  | "logger"
  | "titleGenerationMaxAttempts"
>

/** Connection, logger, and persistence callback used for a generated title. */
type GeneratedTitleHandlingOptions = Pick<
  CreateTitleGenerationTaskOptions,
  "reply" | "logger" | "updateConversationTitle"
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
      /** The SSE client disconnected, so no further title request is made. */
      readonly status: "abandoned"
      /** Title requests made before the disconnect was observed. */
      readonly attempts: number
      /** Failure of the interrupted request, or the abort reason when none was made. */
      readonly error: unknown
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
 * Generates a title for a newly created conversation and reports the outcome.
 *
 * Titles are requested up to `titleGenerationMaxAttempts` times; only a reply
 * unusable as a title consumes another request. A generated title is persisted
 * before one `title` event is sent to a still-connected client. Every other
 * outcome leaves the stored title unchanged, so the conversation keeps its
 * default title, and is logged with `titleGenerationOutcome` and
 * `titleGenerationAttempts` fields: exhausted attempts or a failure that is not
 * retried at warn level, a client disconnect at debug level, and a persistence
 * failure at error level. The task never sends an `error` event.
 *
 * @param options - Chat service, prompt input, attempt limit, cancellation
 * signal, SSE reply, logger, and title persistence callback owned by the route.
 * @returns A promise that resolves after the title is published or the outcome
 * is logged; it does not reject, so the route can await it alongside the chat
 * task.
 */
export default async function createTitleGenerationTask(
  options: CreateTitleGenerationTaskOptions
): Promise<void> {
  const titleGeneration = await generateTitleWithinAttempts(options)
  const { logger } = options

  switch (titleGeneration.status) {
    case "generated":
      await handleGeneratedTitle(options, titleGeneration)
      return
    case "abandoned":
      logger.debug(
        {
          err: titleGeneration.error,
          titleGenerationOutcome: "abandoned",
          titleGenerationAttempts: titleGeneration.attempts
        },
        "Title generation stopped because the chat connection closed"
      )
      return
    case "failed":
      logger.warn(
        {
          err: titleGeneration.error,
          titleGenerationOutcome: "default-title-kept",
          titleGenerationAttempts: titleGeneration.attempts
        },
        "Title generation failed; the conversation keeps its default title"
      )
      return
  }
}

/**
 * Requests a title until one is usable, the attempt limit is reached, or the
 * client disconnects.
 *
 * @remarks Only {@link TitleGenerationOutputError} consumes another attempt.
 * Transport, HTTP, and cancellation failures end generation at once because
 * repeating the request would not change their outcome; the SDK has already
 * retried transient transport failures. Each retried reply is logged at debug
 * level.
 * @param options - Chat service, prompt input, signal, logger, and attempt limit.
 * @returns A promise that resolves to the generation result; it does not reject.
 */
async function generateTitleWithinAttempts({
  chatService,
  userMessageContent,
  model,
  abortSignal,
  logger,
  titleGenerationMaxAttempts
}: TitleGenerationAttemptOptions): Promise<TitleGenerationResult> {
  let attempts = 0

  while (true) {
    if (abortSignal.aborted) {
      return { status: "abandoned", attempts, error: abortSignal.reason }
    }

    attempts += 1
    try {
      const title = await chatService.generateTitle({
        message: userMessageContent,
        model,
        signal: abortSignal
      })
      return { status: "generated", title, attempts }
    } catch (error) {
      if (abortSignal.aborted) {
        return { status: "abandoned", attempts, error }
      }

      if (
        !(error instanceof TitleGenerationOutputError) ||
        attempts >= titleGenerationMaxAttempts
      ) {
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
 * Persists a generated title and sends it to a still-connected client.
 *
 * @param options - Reply, logger, and persistence callback.
 * @param generatedTitle - Usable title and the requests made to generate it.
 * @returns A promise that resolves after the title is sent or its failure is
 * logged: a persistence failure at error level, in which case no event is
 * sent, and a send failure at debug level. It does not reject.
 */
async function handleGeneratedTitle(
  { reply, logger, updateConversationTitle }: GeneratedTitleHandlingOptions,
  { title, attempts }: GeneratedTitle
): Promise<void> {
  try {
    updateConversationTitle(title)
  } catch (error) {
    logger.error(
      {
        err: error,
        titleGenerationOutcome: "title-not-saved",
        titleGenerationAttempts: attempts
      },
      "Generated title could not be saved"
    )
    return
  }

  if (!reply.sse.isConnected) {
    return
  }

  try {
    await createEventSender(reply)({ type: "title", title })
  } catch (error) {
    logger.debug({ err: error }, "Could not send the title event")
  }
}
