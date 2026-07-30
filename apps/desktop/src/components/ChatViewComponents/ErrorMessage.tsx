import { type ErrorMessage } from "@/app/types"
import { Alert, AlertDescription, AlertTitle } from "../ui/alert"
import { Button } from "../ui/button"

type ErrorMessageProps = {
  message: ErrorMessage
}

export default function ErrorMessage({ message }: ErrorMessageProps) {
  return (
    <Alert
      aria-live="polite"
      className="chat-view__error"
      key={message.id}
      role="status"
      variant="destructive"
    >
      <AlertTitle>{message.title}</AlertTitle>
      <AlertDescription>{message.text}</AlertDescription>
      <Button
        className="chat-view__retry"
        // onClick={onRetry}
        size="sm"
        variant="destructive"
      >
        Retry
      </Button>
    </Alert>
  )
}
