import type { LlmProvider } from "@lys/share"
import { useId, type ReactElement } from "react"
import { Button } from "@/components/ui/button"
import {
  describeLlmProviderTarget,
  type LlmProviderTarget
} from "@/lib/models/llm-provider-target"
import {
  calculateProviderConnectionState,
  calculateProviderStatusTone,
  formatProviderConnectionsSummary,
  formatProviderStatusLabel,
  formatProviderStatusMeta,
  listEnabledProviders,
  listRefreshableProviders,
  type ProviderConnectionState
} from "@/lib/models/provider-connection"
import type { BackendServerStatus } from "@/lib/store"
import type { ProviderModelStates } from "@/lib/store/model-runtime"
import type { ProvidersSettings, SecretsSettings } from "@/lib/store/settings"

/** One turned-on provider and its connection, as its status row shows them. */
type ProviderStatus = {
  /** Provider the row shows, which it names and locates. */
  readonly provider: LlmProviderTarget
  /** That provider's connection, a missing key counted. */
  readonly state: ProviderConnectionState
}

/** Properties accepted by {@link ProviderStatusRow}. */
type ProviderStatusRowProps = ProviderStatus & {
  /** Backend lifecycle state, which explains an `unknown` status. */
  readonly backendStatus: BackendServerStatus
}

/** Properties accepted by {@link ProviderStatusCard}. */
type ProviderStatusCardProps = {
  /** Saved providers: which are on, and their addresses. */
  readonly providers: ProvidersSettings
  /** Saved keys, which tell a provider that needs a key it lacks. */
  readonly secrets: SecretsSettings
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
 * Lists every turned-on provider with its connection, in provider order.
 *
 * @param providers - Saved providers: which are on, and their addresses.
 * @param secrets - Saved keys; a provider that needs a key it lacks is
 * counted as needing one, whatever its status.
 * @param providerModels - What the desktop knows of every provider, of
 * which each turned-on provider's published status is read.
 * @returns One entry for each provider that is on.
 */
function listProviderStatuses(
  providers: ProvidersSettings,
  secrets: SecretsSettings,
  providerModels: ProviderModelStates
): readonly ProviderStatus[] {
  return listEnabledProviders(providers.enabled).map((provider) => ({
    provider: describeLlmProviderTarget(provider, providers),
    state: calculateProviderConnectionState(
      provider,
      providerModels[provider].status,
      secrets
    )
  }))
}

/**
 * Presents one turned-on provider's connection: a tone dot, the status
 * heading, and where the provider is with the next step.
 *
 * @remarks A pure projection of its props. The dot is hidden from assistive
 * technology; the heading carries the state. The heading and the line under
 * it are the row's polite live region, announced together when the
 * provider's connection changes, so one change is one announcement.
 * @param props - Provider, its connection, and the backend's state.
 * @returns The row.
 */
function ProviderStatusRow({
  provider,
  state,
  backendStatus
}: ProviderStatusRowProps): ReactElement {
  return (
    <li className="settings-view__identity settings-view__provider-status-row">
      <span
        aria-hidden="true"
        className="settings-view__status-dot"
        data-tone={calculateProviderStatusTone(state)}
      />
      <div
        aria-atomic="true"
        aria-live="polite"
        className="settings-view__identity-lines"
      >
        <h3>{formatProviderStatusLabel(state, provider)}</h3>
        <p className="settings-view__meta">
          {formatProviderStatusMeta(state, backendStatus, provider)}
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
 * @remarks The parent owns the statuses, the keys, and the requests; the
 * card owns no state, effect, or store access. A turned-on provider that
 * needs a key it lacks is shown as needing one, whatever its status. Each
 * row announces its own provider's changes politely; the list itself is not
 * live. Refresh asks the backend to connect again to each turned-on
 * provider that is not connecting, and is disabled while the backend is not
 * running or every turned-on provider is connecting. It is the pane's only
 * reconnect control.
 * @param props - Parent-owned providers, statuses, backend state, and
 * requests.
 * @returns The provider status card.
 */
export default function ProviderStatusCard({
  providers,
  secrets,
  providerModels,
  backendStatus,
  onRefreshProviders,
  onOpenProviders
}: ProviderStatusCardProps): ReactElement {
  const headingId = useId()
  const statuses = listProviderStatuses(providers, secrets, providerModels)
  const refreshable = listRefreshableProviders(providers, providerModels)
  const isNoneOn = statuses.length === 0

  return (
    <section aria-labelledby={headingId} className="settings-view__card">
      <div className="settings-view__card-row">
        <div className="settings-view__identity-lines">
          <h2 id={headingId}>Provider connections</h2>
          <p className="settings-view__meta">
            {formatProviderConnectionsSummary(statuses.length)}
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
      <ul className="settings-view__provider-status-list">
        {statuses.map(({ provider, state }) => (
          <ProviderStatusRow
            backendStatus={backendStatus}
            key={provider.provider}
            provider={provider}
            state={state}
          />
        ))}
      </ul>
    </section>
  )
}
