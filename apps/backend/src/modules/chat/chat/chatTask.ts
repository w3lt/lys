import type {
  ChatGenerationEvent,
  MessageGenerationOptions
} from "@lys/protocol"
import type { ConversationAssistantMessageFinishReason } from "@lys/share"
import type { FastifyBaseLogger } from "fastify"
import type { ChatCompletionChunk } from "openai/resources/index.mjs"
import type { CompleteChatOptions } from "../../../di/services/chatService"
import type { AssistantMessageCompletion } from "../../../di/services/conversationService/share"
import { ChatCompletionCancelledError } from "../../../utils/errors"

/** Dependencies and persistence callbacks for one owned streamed completion. */
export type CreateChatTaskOptions = Readonly<{
  /** Starts the external model stream; the returned iterator owns upstream cleanup. */
  completeChatStream: (
    input: CompleteChatOptions
  ) => Promise<AsyncIterable<ChatCompletionChunk>>
  /** Persists a terminal transition, returning false after deletion or prior completion. */
  updateAssistantMessageState: (
    completion: AssistantMessageCompletion
  ) => boolean
  /** Persists each delta before it is sent, returning false after deletion or finalization. */
  updateAssistantMessageContent: (content: string) => boolean
  /** Saved prompt, eligible earlier transcript, and current user text in inference order. */
  messages: CompleteChatOptions["messages"]
  /** Model selected by the caller. */
  model: string
  /** Caller-provided sampling and reply length controls. */
  generationOptions: MessageGenerationOptions
  /** Generation-owned cancellation, aborted by stop or shutdown. */
  abortSignal: AbortSignal
  /** Queues one event for every stream following the reply; never waits. */
  sendEvent: (event: ChatGenerationEvent) => void
  /** Logger that records reply failures. */
  logger: FastifyBaseLogger
}>

/**
 * Streams a reply, storing each delta before sending it and the final status
 * before the final event.
 *
 * @param options - Borrowed dependencies and turn-scoped persistence authority.
 * @returns Settlement after completion, cancellation, supersession, deletion,
 * or a reported failure.
 * @throws An `AggregateError` holding the failure that ended the reply
 * followed by the persistence failure, when the failed or interrupted state
 * cannot be stored after that failure; the generation reports that rejection.
 * A delta, completion, or interrupted-state write that throws before that
 * point is itself handled as the failure that ended the reply.
 * @remarks When the task settles without throwing it has sent exactly one
 * final event: `done` after a stored completion; `interrupted` after
 * cancellation, or when a newer turn or a deletion ended the reply; `error`
 * after an upstream failure. Partial text stays stored. Interrupted replies
 * stay in later context; failed replies do not. Only the choice with index 0
 * is used; a chunk without it is skipped. Each failure is logged with the
 * failure as `err`: at debug level when the generation was cancelled or the
 * upstream reports a cancellation, and at error level otherwise.
 */
export default async function createChatTask(
  options: CreateChatTaskOptions
): Promise<void> {
  try {
    const finishReason = await createChatCompletion(options)
    if (finishReason === undefined) {
      options.updateAssistantMessageState({ status: "interrupted" })
      options.sendEvent({ type: "interrupted" })
      return
    }
    const persisted = options.updateAssistantMessageState({
      status: "completed",
      finishReason
    })
    // A reply already finalized elsewhere was superseded by a newer turn or
    // deleted, so it did not complete here.
    options.sendEvent(
      persisted ? { type: "done", finishReason } : { type: "interrupted" }
    )
  } catch (error) {
    handleChatCompletionFailure(options, error)
  }
}

/**
 * Stores and reports a reply whose completion failed or was cancelled.
 *
 * @param options - Turn-scoped persistence, logger, cancellation, and sender.
 * @param error - Failure raised while streaming the reply.
 * @throws An `AggregateError` holding `error` followed by the persistence
 * failure when the terminal state cannot be stored.
 * @remarks The upstream reports a cancelled stream even when the task has not
 * yet observed its own abort, so both mean an interrupted reply. Any other
 * failure stores `failed` and sends an `error` event. Both are logged as
 * {@link createChatTask} describes.
 */
function handleChatCompletionFailure(
  options: CreateChatTaskOptions,
  error: unknown
): void {
  const isCancelled =
    options.abortSignal.aborted || error instanceof ChatCompletionCancelledError
  if (isCancelled) {
    options.logger.debug({ err: error }, "Chat completion was cancelled")
  } else {
    options.logger.error({ err: error }, "Chat completion stream failed")
  }
  try {
    options.updateAssistantMessageState({
      status: isCancelled ? "interrupted" : "failed"
    })
  } catch (persistenceFailure) {
    throw new AggregateError(
      [error, persistenceFailure],
      "Chat failure could not be finalized",
      { cause: persistenceFailure }
    )
  }
  options.sendEvent(
    isCancelled
      ? { type: "interrupted" }
      : { type: "error", message: "Chat completion failed. Please try again." }
  )
}

/**
 * Consumes one upstream stream, storing every delta before sending it.
 *
 * @param options - Turn context, upstream adapter, and generation-owned
 * cancellation.
 * @returns The supported finish reason, or undefined after cancellation,
 * supersession, or deletion.
 * @throws If the upstream fails, ends prematurely, or supplies an unsupported
 * finish reason.
 */
async function createChatCompletion(
  options: CreateChatTaskOptions
): Promise<ConversationAssistantMessageFinishReason | undefined> {
  if (options.abortSignal.aborted) return undefined
  const stream = await options.completeChatStream({
    messages: options.messages,
    model: options.model,
    generationOptions: options.generationOptions,
    signal: options.abortSignal
  })
  for await (const chunk of stream) {
    if (options.abortSignal.aborted) return undefined
    const outcome = createChatChunkEvent(chunk, options)
    if (outcome.status === "discarded") return undefined
    if (outcome.status === "completed") return outcome.finishReason
  }
  if (options.abortSignal.aborted) return undefined
  throw new Error("Model stream ended without a finish reason")
}

/** Result of storing and sending one upstream chunk. */
type ChatChunkOutcome =
  | Readonly<{ /** No terminal marker in this chunk. */ status: "pending" }>
  | Readonly<{
      /** Persistence authority ended through deletion or finalization. */ status: "discarded"
    }>
  | Readonly<{
      /** The model supplied a supported terminal marker. */ status: "completed"
      /** Terminal reason persisted by the enclosing task. */ finishReason: ConversationAssistantMessageFinishReason
    }>

/**
 * Stores and sends the selected completion delta, then interprets its marker.
 *
 * @param chunk - Upstream chunk containing zero or more indexed choices.
 * @param options - Turn-specific delta persistence and the event sender.
 * @returns Continuation, discarded-write, or supported-completion outcome.
 * @throws If persistence fails or the finish reason is unsupported.
 * @remarks Storing and sending happen in one synchronous step, so a follower
 * that reads a snapshot in its own step sees either both or neither.
 */
function createChatChunkEvent(
  chunk: ChatCompletionChunk,
  {
    updateAssistantMessageContent,
    sendEvent
  }: Pick<CreateChatTaskOptions, "updateAssistantMessageContent" | "sendEvent">
): ChatChunkOutcome {
  const choice = chunk.choices.find(({ index }) => index === 0)
  if (!choice) return { status: "pending" }
  const content = choice.delta.content
  if (content) {
    if (!updateAssistantMessageContent(content)) return { status: "discarded" }
    sendEvent({ type: "delta", content })
  }
  const finishReason = choice.finish_reason
  if (!finishReason) return { status: "pending" }
  if (finishReason !== "stop" && finishReason !== "length")
    throw new Error("Unsupported chat finish reason")
  return { status: "completed", finishReason }
}
