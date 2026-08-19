import { type ErrorMessage } from "@/app/types"
import { Alert, AlertDescription, AlertTitle } from "../ui/alert"
import { Button } from "../ui/button"

/** Properties accepted by {@link ErrorMessage}. */
type ErrorMessageProps = {
  /** Legacy error record selected by the parent. */
  message: ErrorMessage
}

/**
 * Presents a legacy error record with an intentionally inactive retry affordance.
 *
 * @remarks Primary category: presentational. The parent owns the error record;
 * this component owns no state or side effects. The alert is
 * announced politely. The visible Retry button currently has no callback, so
 * it does not retry or alter state; that limitation is retained because this
 * component exposes no retry contract.
 * @param props - Error record displayed in the alert.
 * @returns The rendered error alert and inactive retry control.
 */
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
