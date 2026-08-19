/**
 * Domain failure raised when a requested conversation cannot be resolved.
 *
 * @remarks Primary category: framework adapter. The subclass preserves the
 * native `Error` contract while giving route boundaries a stable domain
 * discriminator. It owns no mutable state and is safe to construct per
 * failure; callers translate it to the chat route's not-found response.
 */
export class ConversationNotFoundError extends Error {
  /**
   * Creates a conversation-not-found failure with an optional cause.
   *
   * @param message - Human-readable failure message.
   * @param options - Native error options, including an optional cause.
   */
  constructor(
    message: string = "Conversation not found!",
    options?: ErrorOptions
  ) {
    super(message, options)
  }
}
