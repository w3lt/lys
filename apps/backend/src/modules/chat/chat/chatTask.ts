import type { MessageGenerationOptions } from "@lys/protocol"
import type { ConversationAssistantMessageFinishReason } from "@lys/share"
import type ChatService from "../../../di/services/chatService"
import type { CompleteChatOptions } from "../../../di/services/chatService"
import type { UpdateAssistantMessageStateOptions } from "../../../di/services/conversationService/share"
import { ChatCompletionCancelledError } from "../../../utils/errors"
import {
  createEventSender,
  type ChatRouteReply,
  type ChatRouteRequest
} from "./share"

/** Inputs and owned callbacks for one streamed chat completion task. */
type CreateChatTaskOptions = {
  /** Application-scoped service used to start the model stream. */
  chatService: ChatService
  /** Synchronous persistence callback for the assistant terminal state. */
  updateAssistantMessageState: (
    options: Omit<UpdateAssistantMessageStateOptions, "assistantMessageId">
  ) => void
  /** System prompt sent before the user content. */
  systemPrompt: string
  /** User content sent after the system prompt. */
  userMessageContent: string
  /** Model identifier passed to the chat service. */
  model: string
  /** Signal owned by the route and aborted when the SSE client disconnects. */
  abortSignal: AbortSignal
  /** Request used for structured logging of task failures. */
  request: ChatRouteRequest
  /** Reply whose SSE connection receives delta, done, and error events. */
  reply: ChatRouteReply
  /** Sampling and reply-length controls forwarded to the chat service. */
  generationOptions: MessageGenerationOptions
}

/** Failure caught while persisting an assistant terminal state. */
type AssistantStateUpdateFailure = {
  /** Original value thrown by the synchronous persistence callback. */
  error: unknown
}

/**
 * Starts one streamed assistant completion immediately.
 *
 * The task sends the system prompt and user content to the chat service,
 * forwards content deltas, persists a completed/interrupted/failed assistant
 * state, and emits at most one terminal `done` or `error` event. Only `stop`
 * and `length` finish reasons are supported. A client disconnect aborts the
 * upstream stream and suppresses reporting that requires the closed SSE
 * connection; the route still awaits this task's settlement.
 *
 * @param options - Chat service, request lifecycle, persistence callback, and
 * stream output owned by the route.
 * @returns A promise that resolves after the stream reaches a supported finish
 * reason, observes abort, or reports a failure event.
 * @throws If an error event cannot be sent while the SSE connection remains
 * connected.
 */
export default async function createChatTask(
  options: CreateChatTaskOptions
): Promise<void> {
  const sendEvent = createEventSender(options.reply)
  try {
    await createChatCompletion(options, sendEvent)
  } catch (error) {
    await handleChatCompletionFailure(error, options, sendEvent)
  }
}

/**
 * Streams one assistant completion through its persisted and SSE outcomes.
 *
 * @param options - Chat service, request lifecycle, persistence callback, and
 * stream output owned by the route.
 * @param sendEvent - Sender bound to the task's SSE reply.
 * @returns A promise that resolves after a supported completion or observed
 * graceful abort.
 * @throws If stream establishment, iteration, validation, or delta delivery
 * fails, if a terminal assistant state cannot be persisted, or if the stream
 * ends without a finish reason while not aborted.
 */
async function createChatCompletion(
  options: CreateChatTaskOptions,
  sendEvent: ReturnType<typeof createEventSender>
): Promise<void> {
  const {
    chatService,
    updateAssistantMessageState,
    model,
    systemPrompt,
    userMessageContent,
    abortSignal,
    generationOptions
  } = options
  const systemMessage: CompleteChatOptions["messages"][number] = {
    role: "system",
    content: systemPrompt
  }
  const userMessage: CompleteChatOptions["messages"][number] = {
    role: "user",
    content: userMessageContent
  }
  const messages: CompleteChatOptions["messages"] = [systemMessage, userMessage]
  const stream = await chatService.completeChatStream({
    messages,
    model,
    signal: abortSignal,
    generationOptions
  })

  for await (const chunk of stream) {
    // We request only one completion, whose index is 0.
    // Some chunks may have an empty choices array.
    const choice = chunk.choices.find(({ index }) => index === 0)

    if (!choice) continue

    const content = choice.delta.content
    if (content) {
      await sendEvent({
        type: "delta",
        content
      })
    }

    const finishReason = choice.finish_reason
    if (!finishReason) continue

    if (finishReason !== "stop" && finishReason !== "length") {
      throw new Error(`Unsupported finish reason: ${choice.finish_reason}`)
    }

    await handleChatCompletionFinish(finishReason, options, sendEvent)
    return
  }

  if (abortSignal.aborted) {
    updateAssistantMessageState({
      status: "interrupted"
    })
    return
  }

  throw new Error("Model stream ended without a finish reason")
}

/**
 * Handles a supported completion finish for persistence and SSE delivery.
 *
 * @param finishReason - Supported reason reported by the model stream.
 * @param options - Task persistence callback and request lifecycle boundaries.
 * @param sendEvent - Sender bound to the task's SSE reply.
 * @returns A promise that resolves after completed state is persisted and the
 * event is sent or its failure is logged; it does not reject for a transport
 * failure after persistence succeeds.
 * @throws If the completed assistant state cannot be persisted.
 */
async function handleChatCompletionFinish(
  finishReason: ConversationAssistantMessageFinishReason,
  { updateAssistantMessageState, reply, request }: CreateChatTaskOptions,
  sendEvent: ReturnType<typeof createEventSender>
): Promise<void> {
  updateAssistantMessageState({
    status: "completed",
    finishReason
  })

  if (!reply.sse.isConnected) {
    return
  }

  try {
    await sendEvent({
      type: "done",
      finishReason
    })
  } catch (error) {
    request.log.debug({ err: error }, "Could not send the final chat event")
  }
}

/**
 * Handles a chat completion failure across persistence, diagnostics, and SSE.
 *
 * @param error - Original stream establishment, iteration, validation, or
 * delta-delivery failure.
 * @param options - Task persistence callback and request lifecycle boundaries.
 * @param sendEvent - Sender bound to the task's SSE reply.
 * @returns A promise that resolves after reporting the failure when possible.
 * @throws If the error event cannot be sent while SSE remains connected. If
 * persistence also fails, an aggregate preserves the original, persistence,
 * and event-delivery failures.
 */
async function handleChatCompletionFailure(
  error: unknown,
  {
    updateAssistantMessageState,
    abortSignal,
    reply,
    request
  }: CreateChatTaskOptions,
  sendEvent: ReturnType<typeof createEventSender>
): Promise<void> {
  request.log.error({ err: error }, "Chat completion stream failed")

  const assistantStateFailure = updateAssistantFailureState(
    error,
    updateAssistantMessageState,
    request
  )

  // The client is gone, so there is nowhere to send an error event.
  if (abortSignal.aborted || !reply.sse.isConnected) {
    return
  }

  try {
    await sendEvent({
      type: "error",
      message:
        error instanceof Error ? error.message : "Unknown chat completion error"
    })
  } catch (eventError) {
    if (!assistantStateFailure) {
      throw eventError
    }

    throw new AggregateError(
      [error, assistantStateFailure.error, eventError],
      "Chat completion failure reporting failed",
      { cause: eventError }
    )
  }
}

/**
 * Updates the assistant state for a chat completion failure when possible.
 *
 * @param chatCompletionError - Original chat completion failure.
 * @param updateAssistantMessageState - Synchronous persistence callback for
 * the assistant terminal state.
 * @param request - Request whose logger records a persistence failure.
 * @returns The persistence failure when the state could not be updated;
 * otherwise `undefined`.
 */
function updateAssistantFailureState(
  chatCompletionError: unknown,
  updateAssistantMessageState: CreateChatTaskOptions["updateAssistantMessageState"],
  request: ChatRouteRequest
): AssistantStateUpdateFailure | undefined {
  try {
    updateAssistantMessageState({
      status:
        chatCompletionError instanceof ChatCompletionCancelledError
          ? "interrupted"
          : "failed"
    })
    return undefined
  } catch (error) {
    request.log.error(
      { err: error, chatCompletionError },
      "Could not persist the assistant failure state"
    )
    return { error }
  }
}
