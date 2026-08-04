export class ConversationNotFoundError extends Error {
  constructor(
    message: string = "Conversation not found!",
    options?: ErrorOptions
  ) {
    super(message, options)
  }
}
