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
 * @remarks The parent owns the error
 * message and decides when it is present; this component owns no state,
 * effects, refs, retry behavior, or application capability. The status alert
 * is announced politely and does not interrupt the transcript's focus.
 * @param props - Lifecycle message to present with status semantics.
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
