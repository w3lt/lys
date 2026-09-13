import type { MessageGenerationOptions } from "@lys/protocol"
import type { ChatCompletionChunk } from "openai/resources/index.mjs"
import type { CompleteChatOptions } from "../../../di/services/chatService"
import type { AssistantMessageCompletion } from "../../../di/services/conversationService/share"
import type { ConversationAssistantMessageFinishReason } from "@lys/share"
import {
  createEventSender,
  type ChatRouteReply,
  type ChatRouteRequest
} from "./share"

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
  /** Persists each delta before publication, returning false after deletion. */
  updateAssistantMessageContent: (content: string) => boolean
  /** Saved prompt, eligible earlier transcript, and current user text in inference order. */
  messages: CompleteChatOptions["messages"]
  /** Model selected by the caller. */
  model: string
  /** Route-owned cancellation from the SSE connection. */
  abortSignal: AbortSignal
  /** Request logger used for failures. */
  request: ChatRouteRequest
  /** SSE connection receiving ordered deltas and one terminal chat event. */
  reply: ChatRouteReply
  /** Caller-provided sampling and reply length controls. */
  generationOptions: MessageGenerationOptions
}>

/**
 * Streams a reply, persisting content before publication and status before completion.
 * @param options - Borrowed dependencies and turn-scoped persistence authority.
 * @returns Settlement after completion, cancellation, deletion, or reported failure.
 * @throws If persistence or failure reporting fails; the route observes that rejection.
 * @remarks Partial text remains stored on cancellation and failure. Cancelled replies
 * become interrupted; upstream failures become failed and are excluded from future context.
 */
export default async function createChatTask(
  options: CreateChatTaskOptions
): Promise<void> {
  try {
    const finishReason = await createChatCompletion(options)
    if (finishReason === undefined) {
      options.updateAssistantMessageState({ status: "interrupted" })
      return
    }
    const persisted = options.updateAssistantMessageState({
      status: "completed",
      finishReason
    })
    if (persisted && options.reply.sse.isConnected) {
      await createEventSender(options.reply)({ type: "done", finishReason })
    }
  } catch (error) {
    options.request.log.error({ err: error }, "Chat completion stream failed")
    try {
      options.updateAssistantMessageState({
        status: options.abortSignal.aborted ? "interrupted" : "failed"
      })
    } catch (persistenceFailure) {
      throw new AggregateError(
        [error, persistenceFailure],
        "Chat failure could not be finalized",
        { cause: persistenceFailure }
      )
    }
    if (options.abortSignal.aborted) return
    if (options.reply.sse.isConnected) {
      await createEventSender(options.reply)({
        type: "error",
        message: "Chat completion failed. Please try again."
      })
    }
  }
}

/**
 * Consumes one upstream stream with persistence preceding every emitted delta.
 * @param options - Turn context, upstream adapter, and route-owned cancellation.
 * @returns The supported finish reason, or undefined after cancellation/deletion.
 * @throws If the upstream fails, ends prematurely, or supplies an unsupported finish reason.
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
  const sendEvent = createEventSender(options.reply)
  for await (const chunk of stream) {
    if (options.abortSignal.aborted) return undefined
    const outcome = await createChatChunkEvent(
      chunk,
      options.updateAssistantMessageContent,
      sendEvent
    )
    if (outcome.status === "discarded") return undefined
    if (outcome.status === "completed") return outcome.finishReason
  }
  if (options.abortSignal.aborted) return undefined
  throw new Error("Model stream ended without a finish reason")
}

/** Result of persisting and publishing one upstream chunk. */
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
 * Persists and publishes the selected completion delta, then interprets its marker.
 * @param chunk - Upstream chunk containing zero or more indexed choices.
 * @param updateAssistantMessageContent - Turn-specific delta persistence callback.
 * @param sendEvent - Borrowed ordered SSE publication callback.
 * @returns Continuation, discarded-write, or supported-completion outcome.
 * @throws If persistence/publication fails or the finish reason is unsupported.
 */
async function createChatChunkEvent(
  chunk: ChatCompletionChunk,
  updateAssistantMessageContent: CreateChatTaskOptions["updateAssistantMessageContent"],
  sendEvent: ReturnType<typeof createEventSender>
): Promise<ChatChunkOutcome> {
  const choice = chunk.choices.find(({ index }) => index === 0)
  if (!choice) return { status: "pending" }
  const content = choice.delta.content
  if (content) {
    if (!updateAssistantMessageContent(content)) return { status: "discarded" }
    await sendEvent({ type: "delta", content })
  }
  const finishReason = choice.finish_reason
  if (!finishReason) return { status: "pending" }
  if (finishReason !== "stop" && finishReason !== "length")
    throw new Error("Unsupported chat finish reason")
  return { status: "completed", finishReason }
}
