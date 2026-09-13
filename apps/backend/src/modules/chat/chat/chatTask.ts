import type { MessageGenerationOptions } from "@lys/protocol"
import type ChatService from "../../../di/services/chatService"
import type { UpdateAssistantMessageStateOptions } from "../../../di/services/conversationService/share"
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
export default async function createChatTask({
  chatService,
  updateAssistantMessageState,
  model,
  systemPrompt,
  userMessageContent,
  abortSignal,
  reply,
  request,
  generationOptions
}: CreateChatTaskOptions) {
  const sendEvent = createEventSender(reply)
  try {
    const stream = await chatService.completeChatStream({
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: userMessageContent
        }
      ],
      model,
      generationOptions,
      signal: abortSignal
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

      updateAssistantMessageState({
        finishReason,
        status: "completed"
      })

      if (reply.sse.isConnected) {
        try {
          await sendEvent({
            type: "done",
            finishReason
          })
        } catch (error) {
          request.log.debug(
            { err: error },
            "Could not send the final chat event"
          )
        }
      }

      return
    }

    if (abortSignal.aborted) {
      updateAssistantMessageState({
        status: "interrupted"
      })
      return
    }

    throw new Error("Model stream ended without a finish reason")
  } catch (error) {
    if (abortSignal.aborted) {
      updateAssistantMessageState({
        status: "failed"
      })
    }

    request.log.error({ err: error }, "Chat completion stream failed")

    // The client is gone, so there is nowhere to send an error event.
    if (abortSignal.aborted || !reply.sse.isConnected) {
      return
    }

    await sendEvent({
      type: "error",
      message:
        error instanceof Error ? error.message : "Unknown chat completion error"
    })
  }
}
