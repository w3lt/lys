import type { ReactElement } from "react"
import { Button } from "@/components/ui/button"
import type { LlmProviderTarget } from "@/lib/models/llm-provider-target"
import {
  calculateProviderStatusTone,
  formatProviderStatusLabel,
  formatProviderStatusMeta
} from "@/lib/models/provider-connection"
import type { BackendServerStatus } from "@/lib/store"
import type { LlmProviderStatus } from "@/lib/store/model-runtime"

/** Properties accepted by {@link LmStudioStatusCard}. */
type LmStudioStatusCardProps = {
  /** Provider the card shows, which it names and locates. */
  readonly provider: LlmProviderTarget
  /** Latest status of that provider published by the application store. */
  readonly status: LlmProviderStatus
  /** Backend lifecycle state; only a running backend can be asked to reconnect. */
  readonly backendStatus: BackendServerStatus
  /** Requests one new connection attempt to the provider from the backend. */
  readonly onRefreshStatus: () => void
}

/**
 * Presents the backend's connection status to one provider with one Refresh
 * action.
 *
 * @remarks The parent owns the status and the refresh request; the card owns
 * no state, effect, or store access. The heading and meta line are announced
 * politely when they change. Refresh is disabled while the backend is not
 * running, an attempt is connecting, or the provider is off, and is the only
 * reconnect control.
 * @param props - Parent-owned provider, status, backend state, and refresh
 * request.
 * @returns The provider status card.
 */
export default function LmStudioStatusCard({
  provider,
  status,
  backendStatus,
  onRefreshStatus
}: LmStudioStatusCardProps): ReactElement {
  const canRefresh =
    backendStatus === "running" && status !== "connecting" && status !== "off"

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
            data-tone={calculateProviderStatusTone(status)}
          />
          <div aria-live="polite" className="settings-view__identity-lines">
            <h2>{formatProviderStatusLabel(status, provider)}</h2>
            <p className="settings-view__meta">
              {formatProviderStatusMeta(status, backendStatus, provider)}
            </p>
          </div>
        </div>
        <div className="settings-view__actions">
          <Button
            disabled={!canRefresh}
            onClick={() => {
              onRefreshStatus()
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
