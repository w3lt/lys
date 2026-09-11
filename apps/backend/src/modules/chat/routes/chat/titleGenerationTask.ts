import type ChatService from "../../../../di/services/chatService"
import { createEventSender, type ChatRouteReply } from "./share"

/** Inputs and persistence callback for one title-generation task. */
type CreateTitleGenerationTaskOptions = {
  /** Application-scoped service used to generate the title. */
  chatService: ChatService
  /** User content used as the title-generation prompt. */
  userMessageContent: string
  /** Model identifier passed to the chat service. */
  model: string
  /** Signal owned by the route and aborted when the SSE client disconnects. */
  abortSignal: AbortSignal
  /** Reply whose SSE connection receives title and error events. */
  reply: ChatRouteReply
  /** Synchronous persistence callback run before the title event is sent. */
  updateConversationTitle: (title: string) => void
}

/**
 * Starts title generation immediately and reports its result over SSE.
 *
 * A successful task persists the generated title before sending one `title`
 * event. Generation and persistence failures are translated to an `error`
 * event; sending that event is still attempted after connection closure and
 * may therefore reject when the reply no longer accepts writes. The route
 * awaits this task alongside the chat completion task.
 *
 * @param options - Chat service, cancellation signal, SSE reply, and title
 * persistence callback owned by the route.
 * @returns A promise that resolves after title persistence and event delivery,
 * or after a failure event is delivered.
 * @throws If the title or failure event cannot be sent through SSE.
 */
export default async function createTitleGenerationTask({
  chatService,
  abortSignal,
  userMessageContent: message,
  model,
  reply,
  updateConversationTitle
}: CreateTitleGenerationTaskOptions) {
  const sendEvent = createEventSender(reply)

  try {
    const title = await chatService.generateTitle({
      message,
      model,
      signal: abortSignal
    })

    updateConversationTitle(title)

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
