import ChatMessage from "./ChatMessage"
import { type ConversationMessage } from "@lys/share"

type ConversationContent = {
  messages: ConversationMessage[]
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
