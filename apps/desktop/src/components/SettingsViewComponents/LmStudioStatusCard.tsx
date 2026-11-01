import type { ReactElement } from "react"
import { Button } from "@/components/ui/button"
import {
  calculateLmStudioStatusTone,
  formatLmStudioStatusLabel,
  formatLmStudioStatusMeta
} from "@/lib/models/lm-studio-connection"
import type { LlmProviderTarget } from "@/lib/models/llm-provider-target"
import type { BackendServerStatus } from "@/lib/store"
import type { LmStudioStatus } from "@/lib/store/lm-studio-status"

/** Properties accepted by {@link LmStudioStatusCard}. */
type LmStudioStatusCardProps = {
  /** Active provider, which the card names and locates. */
  readonly provider: LlmProviderTarget
  /** Latest provider status published by the application store. */
  readonly lmStudioStatus: LmStudioStatus
  /** Backend lifecycle state; only a running backend can be asked to reconnect. */
  readonly backendStatus: BackendServerStatus
  /** Requests one new provider connection attempt from the backend. */
  readonly onRefreshLmStudioStatus: () => void
}

/**
 * Presents the backend's connection status to the active provider with one
 * Refresh action.
 *
 * @remarks The parent owns the status and the refresh request; the card owns
 * no state, effect, or store access. The heading and meta line are announced
 * politely when they change. Refresh is disabled while the backend is not
 * running or an attempt is connecting, and is the only reconnect control.
 * @param props - Parent-owned status, backend state, and refresh request.
 * @returns The LM Studio status card.
 */
export default function LmStudioStatusCard({
  provider,
  lmStudioStatus,
  backendStatus,
  onRefreshLmStudioStatus
}: LmStudioStatusCardProps): ReactElement {
  const canRefresh =
    backendStatus === "running" && lmStudioStatus !== "connecting"

  return (
    <section
      aria-label={`${provider.name} connection`}
      className="settings-view__card"
    >
      <div className="settings-view__card-row">
        <div className="settings-view__identity">
          <span
            aria-hidden="true"
            className="settings-view__status-dot"
            data-tone={calculateLmStudioStatusTone(lmStudioStatus)}
          />
          <div aria-live="polite" className="settings-view__identity-lines">
            <h2>{formatLmStudioStatusLabel(lmStudioStatus, provider)}</h2>
            <p className="settings-view__meta">
              {formatLmStudioStatusMeta(
                lmStudioStatus,
                backendStatus,
                provider
              )}
            </p>
          </div>
        </div>
        <div className="settings-view__actions">
          <Button
            disabled={!canRefresh}
            onClick={() => {
              onRefreshLmStudioStatus()
            }}
            type="button"
            variant="outline"
          >
            Refresh
          </Button>
        </div>
      </div>
    </section>
  )
}
