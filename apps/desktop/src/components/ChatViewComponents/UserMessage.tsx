import { type ConversationUserMessage } from "@lys/share"

type UserMessageProps = {
  message: ConversationUserMessage
}

export default function UserMessage({ message }: UserMessageProps) {
  return (
    <article className="chat-view__message" key={message.id}>
      <p className="chat-view__speaker">you</p>
      <p className="chat-view__user-copy">{message.content}</p>
    </article>
  )
}
