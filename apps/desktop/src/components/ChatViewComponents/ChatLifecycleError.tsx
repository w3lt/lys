import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import type { ReactElement } from "react"

/** Properties accepted by {@link ChatLifecycleError}. */
export type ChatLifecycleErrorProps = {
  /** Human-readable lifecycle failure or warning shown to the user. */
  readonly message: string
}

/**
 * Renders a polite inline chat lifecycle outcome.
 *
 * @param props - Lifecycle message to present without alert semantics.
 * @returns The rendered inline status.
 */
export default function ChatLifecycleError({
  message
}: ChatLifecycleErrorProps): ReactElement {
  return (
    <Alert
      aria-live="polite"
      className="chat-view__error"
      role="status"
      variant="destructive"
    >
      <AlertTitle>Chat issue</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}
