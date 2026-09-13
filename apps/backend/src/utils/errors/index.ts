/**
 * Domain failure raised when a requested conversation cannot be resolved.
 *
 * @remarks The subclass preserves the
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

/**
 * Failure raised when a title-generation endpoint answers with a reply that
 * cannot be used as a conversation title.
 *
 * @remarks Covers a truncated reply, a reply without content, content that is
 * not JSON after one surrounding Markdown code fence is unwrapped, content that
 * does not match the title shape or length limit, and a blank title. Transport,
 * HTTP, and cancellation failures are never represented by this class, so
 * title generation can treat it as the only failure worth another request.
 * The subclass preserves the native `Error` contract, owns no mutable state,
 * and keeps the underlying parse failure as its cause when one exists.
 */
export class TitleGenerationOutputError extends Error {
  /**
   * Creates an unusable-title-output failure with an optional cause.
   *
   * @param message - Human-readable reason the reply is unusable.
   * @param options - Native error options, including an optional cause.
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
  }
}
