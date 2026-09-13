import type { TitleGenerationOptions } from "../../../di/services/chatService"
import {
  createEventSender,
  type ChatRouteReply,
  type ChatRouteRequest
} from "./share"

/** Inputs for title generation while a conversation has no stored title. */
type CreateTitleGenerationTaskOptions = Readonly<{
  /** Starts the external title request, borrowing the application adapter. */
  generateTitle: (options: TitleGenerationOptions) => Promise<string>
  /** Current user content used as title context. */
  userMessageContent: string
  /** Caller-selected model. */
  model: string
  /** Route-owned cancellation signal. */
  abortSignal: AbortSignal
  /** SSE output for a successfully assigned title. */
  reply: ChatRouteReply
  /** Request logger for generation or persistence failure. */
  request: ChatRouteRequest
  /** Conditional write returning the saved title, or undefined after rename/deletion. */
  updateConversationTitle: (title: string) => string | undefined
}>

/**
 * Generates a title and publishes it only if the absent-title write succeeds.
 * @param options - Borrowed generator, cancellation, and conditional persistence.
 * @returns Settlement after publication, a lost title race, cancellation, or reported failure.
 * @throws If reporting a failure to an open SSE connection itself fails.
 */
export default async function createTitleGenerationTask(
  options: CreateTitleGenerationTaskOptions
): Promise<void> {
  if (options.abortSignal.aborted) return
  const sendEvent = createEventSender(options.reply)
  try {
    const title = await options.generateTitle({
      message: options.userMessageContent,
      model: options.model,
      signal: options.abortSignal
    })
    if (options.abortSignal.aborted) return
    const persistedTitle = options.updateConversationTitle(title)
    if (persistedTitle === undefined || !options.reply.sse.isConnected) return
    await sendEvent({ type: "title", title: persistedTitle })
  } catch (error) {
    if (options.abortSignal.aborted) return
    options.request.log.error(
      { err: error },
      "Conversation title generation failed"
    )
    if (options.reply.sse.isConnected) {
      await sendEvent({
        type: "error",
        message: "Conversation title generation failed."
      })
    }
  }
}
