import { type ConversationMessage } from "@lys/share"
import { lazy } from "react"

const UserMessage = lazy(() => import("./UserMessage"))
const LysMessage = lazy(() => import("./LysMessage"))

type ChatMessageProps = {
  message: ConversationMessage
}

export default function ChatMessage({ message }: ChatMessageProps) {
  switch (message.role) {
    case "user":
      return <UserMessage message={message} />
    case "assistant":
      return <LysMessage message={message} />
    default:
      return null
  }
}
