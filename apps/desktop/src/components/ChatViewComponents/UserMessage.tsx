import { type UserMessage } from "@/app/types"

type UserMessageProps = {
  message: UserMessage
}

export default function UserMessage({ message }: UserMessageProps) {
  return (
    <article className="chat-view__message" key={message.id}>
      <p className="chat-view__speaker">you</p>
      <p className="chat-view__user-copy">{message.text}</p>
    </article>
  )
}
