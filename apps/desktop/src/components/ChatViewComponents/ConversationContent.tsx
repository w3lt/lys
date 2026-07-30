import { Message } from "@/app/types"
import ChatMessage from "./ChatMessage"

type ConversationContent = {
  messages: Message[]
}

export default function ConversationContent({ messages }: ConversationContent) {
  return (
    <div className="chat-view__transcript">
      {messages.map((message) => (
        <ChatMessage key={message.id} message={message} />
      ))}
    </div>
  )
}
