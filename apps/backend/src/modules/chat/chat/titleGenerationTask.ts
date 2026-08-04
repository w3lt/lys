import type ChatService from "../../../di/services/chatService"
import { createEventSender, type ChatRouteReply } from "./share"

type CreateTitleGenerationTaskOptions = {
  chatService: ChatService
  userMessageContent: string
  model: string
  abortSignal: AbortSignal
  reply: ChatRouteReply
}

export default async function createTitleGenerationTask({
  chatService,
  abortSignal,
  userMessageContent: message,
  model,
  reply
}: CreateTitleGenerationTaskOptions) {
  const sendEvent = createEventSender(reply)

  try {
    const title = await chatService.generateTitle({
      message,
      model,
      signal: abortSignal
    })

    await sendEvent({
      type: "title",
      title
    })
  } catch (error) {
    await sendEvent({
      type: "error",
      message:
        error instanceof Error
          ? error.message
          : "Unknown title generation error"
    })
  }
}
