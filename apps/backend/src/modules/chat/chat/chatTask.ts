import type ChatService from "../../../di/services/chatService"
import type { UpdateAssistantMessageStateOptions } from "../../../di/services/conversationService"
import {
  createEventSender,
  type ChatRouteReply,
  type ChatRouteRequest
} from "./share"

type CreateChatTaskOptions = {
  chatService: ChatService
  updateAssistantMessageState: (
    options: Omit<UpdateAssistantMessageStateOptions, "assistantMessageId">
  ) => void
  userMessageContent: string
  model: string
  abortSignal: AbortSignal
  request: ChatRouteRequest
  reply: ChatRouteReply
}

export default async function createChatTask({
  chatService,
  updateAssistantMessageState,
  model,
  userMessageContent,
  abortSignal,
  reply,
  request
}: CreateChatTaskOptions) {
  const sendEvent = createEventSender(reply)
  try {
    const stream = await chatService.completeChatStream({
      messages: [
        {
          role: "user",
          content: userMessageContent
        }
      ],
      model,
      stream: true,
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
