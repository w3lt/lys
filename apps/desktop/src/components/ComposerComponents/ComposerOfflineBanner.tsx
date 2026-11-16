import { Button } from "@/components/ui/button"

import type { ComposerBannerAction } from "./composer-presentation"

/** Properties accepted by {@link ComposerOfflineBanner}. */
export type ComposerOfflineBannerProps = {
  /** Sentence explaining why the conversation's model cannot answer. */
  readonly message: string
  /** The recovery action; disabled while it is `none`. */
  readonly action: ComposerBannerAction
  /** Invoked once when the recovery action is activated. */
  readonly onReconnect: () => void
}

/**
 * States why the conversation's model cannot answer and offers the recovery
 * action.
 *
 * @remarks The parent owns the message, the action, and the callback, and
 * carries the action out; this component owns no state, effects, or
 * resources. The banner is a polite status region so a reader is told about
 * the change without losing their place in the composer, and the button is
 * disabled rather than hidden while the runtime is already transitioning,
 * keeping the row's height stable.
 *
 * @param props - Explanation copy and the parent-owned recovery action.
 * @returns The composer's runtime availability banner.
 */
export default function ComposerOfflineBanner({
  message,
  action,
  onReconnect
}: ComposerOfflineBannerProps) {
  return (
    <div aria-live="polite" className="composer__offline" role="status">
      <span aria-hidden="true" className="composer__offline-dot" />
      <span className="composer__offline-message">{message}</span>
      <Button
        className="composer__offline-action"
        disabled={action.kind === "none"}
        onClick={onReconnect}
        size="sm"
        type="button"
      >
        {action.label}
      </Button>
    </div>
  )
}
