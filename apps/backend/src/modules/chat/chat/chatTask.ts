import type ChatService from "../../../di/services/chatService"
import {
  createEventSender,
  type ChatRouteReply,
  type ChatRouteRequest
} from "./share"

type CreateChatTaskOptions = {
  chatService: ChatService
  userMessageContent: string
  model: string
  abortSignal: AbortSignal
  request: ChatRouteRequest
  reply: ChatRouteReply
}

export default async function createChatTask({
  chatService,
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
        sendEvent({
          type: "delta",
          content
        })
      }

      switch (choice.finish_reason) {
        case null:
          continue

        case "stop":
        case "length":
          await sendEvent({
            type: "done",
            finishReason: choice.finish_reason
          })
          return

        default:
          throw new Error(`Unsupported finish reason: ${choice.finish_reason}`)
      }
    }

    throw new Error("Model stream ended without a finish reason")
  } catch (error) {
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
