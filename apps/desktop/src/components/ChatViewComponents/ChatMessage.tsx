import { type Message } from "@/app/types"
import { lazy } from "react"

const UserMessage = lazy(() => import("./UserMessage"))
const ErrorMessage = lazy(() => import("./ErrorMessage"))
const LysMessage = lazy(() => import("./LysMessage"))

type ChatMessageProps = {
  message: Message
}

export default function ChatMessage({
  message
}: ChatMessageProps) {
  switch (message.role) {
    case "user":
      return <UserMessage message={message} />
    case "lys":
      return <LysMessage message={message} />
    case "error":
      return <ErrorMessage message={message} />
    default:
      return null
  }
}
