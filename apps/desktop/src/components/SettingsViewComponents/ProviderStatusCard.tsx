import type { LlmProvider } from "@lys/share"
import { useId, type ReactElement } from "react"
import { Button } from "@/components/ui/button"
import {
  describeLlmProviderTarget,
  type LlmProviderTarget
} from "@/lib/models/llm-provider-target"
import {
  calculateProviderStatusTone,
  formatProviderConnectionsSummary,
  formatProviderStatusLabel,
  formatProviderStatusMeta,
  listEnabledProviders,
  listRefreshableProviders
} from "@/lib/models/provider-connection"
import type { BackendServerStatus } from "@/lib/store"
import type {
  LlmProviderStatus,
  ProviderModelStates
} from "@/lib/store/model-runtime"
import type { ProvidersSettings } from "@/lib/store/settings"

/** Properties accepted by {@link ProviderStatusRow}. */
type ProviderStatusRowProps = {
  /** Provider the row shows, which it names and locates. */
  readonly provider: LlmProviderTarget
  /** Latest status of that provider published by the application store. */
  readonly status: LlmProviderStatus
  /** Backend lifecycle state, which explains an `unknown` status. */
  readonly backendStatus: BackendServerStatus
}

/** Properties accepted by {@link ProviderStatusCard}. */
type ProviderStatusCardProps = {
  /** Saved providers: which are on, and their addresses. */
  readonly providers: ProvidersSettings
  /** What the desktop knows of every provider, of which the card reads the status. */
  readonly providerModels: ProviderModelStates
  /** Backend lifecycle state; only a running backend can be asked to reconnect. */
  readonly backendStatus: BackendServerStatus
  /**
   * Requests one new connection attempt to each listed provider from the
   * backend, once per press of Refresh.
   *
   * @param providers - Turned-on providers that are not connecting, in
   * provider order.
   */
  readonly onRefreshProviders: (providers: readonly LlmProvider[]) => void
  /** Requests that the settings view show the Providers pane. */
  readonly onOpenProviders: () => void
}

/**
 * Presents one turned-on provider's connection: a tone dot, the status
 * heading, and where the provider is with the next step.
 *
 * @remarks A pure projection of its props. The dot is hidden from assistive
 * technology; the heading carries the state.
 * @param props - Provider, its status, and the backend's state.
 * @returns The row.
 */
function ProviderStatusRow({
  provider,
  status,
  backendStatus
}: ProviderStatusRowProps): ReactElement {
  return (
    <li className="settings-view__identity settings-view__provider-status-row">
      <span
        aria-hidden="true"
        className="settings-view__status-dot"
        data-tone={calculateProviderStatusTone(status)}
      />
      <div className="settings-view__identity-lines">
        <h3>{formatProviderStatusLabel(status, provider)}</h3>
        <p className="settings-view__meta">
          {formatProviderStatusMeta(status, backendStatus, provider)}
        </p>
      </div>
    </li>
  )
}

/**
 * Presents the backend's connection to every turned-on provider, in provider
 * order, with one Refresh action; or, while no provider is on, says so and
 * offers to open Providers.
 *
 * @remarks The parent owns the statuses and the requests; the card owns no
 * state, effect, or store access. The rows are announced politely when they
 * change. Refresh asks the backend to connect again to each turned-on
 * provider that is not connecting, and is disabled while the backend is not
 * running or every turned-on provider is connecting. It is the pane's only
 * reconnect control.
 * @param props - Parent-owned providers, statuses, backend state, and
 * requests.
 * @returns The provider status card.
 */
export default function ProviderStatusCard({
  providers,
  providerModels,
  backendStatus,
  onRefreshProviders,
  onOpenProviders
}: ProviderStatusCardProps): ReactElement {
  const headingId = useId()
  const enabled = listEnabledProviders(providers.enabled)
  const refreshable = listRefreshableProviders(providers, providerModels)
  const isNoneOn = enabled.length === 0

  return (
    <section aria-labelledby={headingId} className="settings-view__card">
      <div className="settings-view__card-row">
        <div className="settings-view__identity-lines">
          <h2 id={headingId}>Provider connections</h2>
          <p className="settings-view__meta">
            {formatProviderConnectionsSummary(enabled.length)}
          </p>
        </div>
        <div className="settings-view__actions">
          {isNoneOn ? (
            <Button onClick={onOpenProviders} type="button" variant="outline">
              Open Providers
            </Button>
          ) : (
            <Button
              disabled={backendStatus !== "running" || refreshable.length === 0}
              onClick={() => {
                onRefreshProviders(refreshable)
              }}
              type="button"
              variant="outline"
            >
              Refresh
            </Button>
          )}
        </div>
      </div>
      <ul aria-live="polite" className="settings-view__provider-status-list">
        {enabled.map((provider) => (
          <ProviderStatusRow
            backendStatus={backendStatus}
            key={provider}
            provider={describeLlmProviderTarget(provider, providers)}
            status={providerModels[provider].status}
          />
        ))}
      </ul>
    </section>
  )
}
