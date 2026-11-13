import type { LlmRuntimeConnectionStatus } from "@lys/protocol"
import { LLM_PROVIDERS, type LlmProvider } from "@lys/share"
import type { StoreApi } from "zustand"
import type { ModelApiConnection } from "@/lib/apis/http/models"
import {
  connectLlmRuntime,
  getLlmRuntimeConnectionStatus
} from "@/lib/apis/http/runtime"

import {
  updateProviderModelState,
  type LlmProviderStatus,
  type ProviderModelStates
} from "./model-runtime"

/** Backend origin and readiness sampled from the owning store. */
export type ProviderBackendConnection = {
  /** Backend origin used for status requests. */
  readonly backendUrl: string
  /** Whether the backend's health route answered, so status requests are admitted. */
  readonly isBackendRunning: boolean
}

/** Store capabilities the provider status slice reads and notifies. */
export type ProviderStatusSliceDependencies = {
  /** Reads the current backend origin and readiness. */
  readonly getBackendConnection: () => ProviderBackendConnection
  /**
   * Receives each changed status after it is published.
   *
   * @param provider - Provider whose status changed.
   * @param status - Its newly published status.
   */
  readonly handleProviderStatusChange: (
    provider: LlmProvider,
    status: LlmProviderStatus
  ) => void
}

/** The part of the application state the provider status slice shares. */
export type ProviderModelsState = {
  /** What the desktop knows of every provider, keyed by provider. */
  readonly providerModels: ProviderModelStates
}

/** Provider status actions composed into the application store. */
export type ProviderStatusActions = {
  /**
   * Reads and publishes the backend's status of one provider; a
   * `connecting` status is then replaced by the settled result of the
   * backend's pending attempt.
   *
   * @param provider - Provider whose status is read.
   * @returns Resolves after publication or supersession; never rejects.
   */
  updateProviderStatus: (provider: LlmProvider) => Promise<void>
  /**
   * Reads every provider's status at once, as
   * {@link ProviderStatusActions.updateProviderStatus} reads one.
   *
   * @returns Resolves once every provider's read settled; never rejects.
   * @remarks The backend answers `off` for a provider that is turned off.
   */
  updateProviderStatuses: () => Promise<void>
  /**
   * Asks the backend to connect to one provider again, publishing
   * `connecting` first and then the settled status.
   *
   * @param provider - Provider to connect.
   * @returns Resolves after publication or supersession; never rejects.
   * @remarks The backend answers `off` without trying when the provider is
   * turned off.
   */
  connectProvider: (provider: LlmProvider) => Promise<void>
  /** Publishes `unknown` for every provider and abandons every status request. */
  resetProviderStatuses: () => void
}

/** One backend request producing a provider's connection status. */
type ProviderStatusRequest = (
  provider: LlmProvider,
  connection: ModelApiConnection
) => Promise<LlmRuntimeConnectionStatus>

/**
 * Registers the provider status actions with one Zustand owner.
 *
 * @param set - Framework setter for atomic status updates.
 * @param get - Framework reader for the current statuses.
 * @param dependencies - Backend connection reader and status-change reaction.
 * @returns The actions; the owning store holds the statuses, each `unknown`
 * at first, in `providerModels`.
 * @remarks Each provider has at most one current status request; a new
 * request for that provider, or a reset, abandons its previous one locally,
 * and requests for different providers run at once. A response is published
 * only while its request is current and the backend still runs. A failed
 * request publishes `unknown`. Requests are admitted only while the backend
 * runs. Only the status field of a provider's state is written here.
 */
export function createProviderStatusSlice(
  set: StoreApi<ProviderModelsState>["setState"],
  get: StoreApi<ProviderModelsState>["getState"],
  dependencies: ProviderStatusSliceDependencies
): ProviderStatusActions {
  const currentRequests = new Map<LlmProvider, AbortController>()

  /**
   * Publishes a provider's status and notifies the store when it changed.
   *
   * @param provider - Provider whose status is published.
   * @param status - Status to publish.
   */
  function updateProviderStatusValue(
    provider: LlmProvider,
    status: LlmProviderStatus
  ): void {
    if (get().providerModels[provider].status === status) return
    set((state) => ({
      providerModels: updateProviderModelState(state.providerModels, provider, {
        status
      })
    }))
    dependencies.handleProviderStatusChange(provider, status)
  }

  /**
   * Owns one status request of one provider from admission to publication.
   *
   * @param provider - Provider the request is for.
   * @param request - Backend request producing the status.
   * @returns Resolves to the published status, or `null` when the request was
   * not admitted or was superseded; never rejects.
   */
  async function startProviderStatusRequest(
    provider: LlmProvider,
    request: ProviderStatusRequest
  ): Promise<LlmProviderStatus | null> {
    const { backendUrl, isBackendRunning } = dependencies.getBackendConnection()
    if (!isBackendRunning) return null
    currentRequests.get(provider)?.abort()
    const controller = new AbortController()
    currentRequests.set(provider, controller)
    const status = await request(provider, {
      backendUrl,
      signal: controller.signal
    }).catch((): LlmProviderStatus => "unknown")
    if (currentRequests.get(provider) !== controller) return null
    currentRequests.delete(provider)
    if (!dependencies.getBackendConnection().isBackendRunning) return null
    updateProviderStatusValue(provider, status)
    return status
  }

  /**
   * Implements {@link ProviderStatusActions.updateProviderStatus}.
   *
   * @param provider - Provider whose status is read.
   * @remarks A published `connecting` status is followed by a connect request
   * that joins the backend's pending attempt for that provider; if that
   * attempt settled in the meantime, or the provider's settings changed, the
   * request starts a new one.
   */
  async function updateProviderStatus(provider: LlmProvider): Promise<void> {
    const status = await startProviderStatusRequest(
      provider,
      getLlmRuntimeConnectionStatus
    )
    if (status === "connecting") {
      await startProviderStatusRequest(provider, connectLlmRuntime)
    }
  }

  /** Implements {@link ProviderStatusActions.updateProviderStatuses}. */
  async function updateProviderStatuses(): Promise<void> {
    await Promise.all(
      LLM_PROVIDERS.map((provider) => updateProviderStatus(provider))
    )
  }

  /**
   * Implements {@link ProviderStatusActions.connectProvider}.
   *
   * @param provider - Provider to connect.
   */
  async function connectProvider(provider: LlmProvider): Promise<void> {
    if (!dependencies.getBackendConnection().isBackendRunning) return
    updateProviderStatusValue(provider, "connecting")
    await startProviderStatusRequest(provider, connectLlmRuntime)
  }

  /** Implements {@link ProviderStatusActions.resetProviderStatuses}. */
  function resetProviderStatuses(): void {
    for (const controller of currentRequests.values()) controller.abort()
    currentRequests.clear()
    for (const provider of LLM_PROVIDERS) {
      updateProviderStatusValue(provider, "unknown")
    }
  }

  return {
    updateProviderStatus,
    updateProviderStatuses,
    connectProvider,
    resetProviderStatuses
  }
}
