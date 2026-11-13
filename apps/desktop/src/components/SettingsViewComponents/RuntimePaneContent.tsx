import type { LlmProvider } from "@lys/share"
import type { ReactElement } from "react"
import BackendStatusCard from "./BackendStatusCard"
import ModelRequestFeedback from "./ModelRequestFeedback"
import ModelResidencyCard from "./ModelResidencyCard"
import ProviderStatusCard from "./ProviderStatusCard"
import StartupSwitchSaveStatus from "./StartupSwitchSaveStatus"
import VmoStatusCard from "./VmoStatusCard"
import { useBackendUptimeMs } from "@/lib/hooks/backendRuntime"
import { useNewConversationModel } from "@/lib/hooks/conversationModel"
import { calculateProviderAvailability } from "@/lib/models/provider-connection"
import { useLysStore } from "@/lib/store"
import {
  RELEASED_PROVIDER_MODELS,
  type ProviderModelState
} from "@/lib/store/model-runtime"

import { useSettingsContext } from "./SettingsContext"

/**
 * Presents the cards of the two processes the desktop host runs for Lys, the
 * backend and then vmo, and under them the save status of their startup
 * switches.
 *
 * @remarks The application store owns both processes' status, their start
 * and stop commands, and the save of the switches; the settings context owns
 * the switches and the backend address. Start and Stop intentionally discard
 * their command promises with `void`. The backend's failures are not awaited
 * or rendered here, so a rejection surfaces as an unhandled rejection and
 * backend status is not a completion owner when a command rejects; vmo's
 * start and stop never reject and publish their problem in the vmo card.
 * Each startup switch proposes one runtime patch per change, which the
 * application store saves. The backend's uptime ticks each second, which
 * re-renders this group but not the model runtime cards. The group renders
 * no host of its own, so each card takes its place in the pane's stack.
 * @returns The backend card, the vmo card, and the save status.
 */
function ProcessCardGroup(): ReactElement {
  const backendStatus = useLysStore((state) => state.backendServerInfo.status)
  const startBackend = useLysStore((state) => state.startBackend)
  const stopBackend = useLysStore((state) => state.stopBackend)
  const vmoServerInfo = useLysStore((state) => state.vmoServerInfo)
  const startVmo = useLysStore((state) => state.startVmo)
  const stopVmo = useLysStore((state) => state.stopVmo)
  const runtimeAutoStartSave = useLysStore(
    (state) => state.runtimeAutoStartSave
  )
  const uptimeMs = useBackendUptimeMs()
  const { settings, onRuntimeChange } = useSettingsContext()

  return (
    <>
      <BackendStatusCard
        backendAddress={settings.runtime.backendAddress}
        backendStatus={backendStatus}
        isAutoStartOn={settings.runtime.autoStartBackend}
        onIsAutoStartOnChange={(isAutoStartOn) =>
          onRuntimeChange({ autoStartBackend: isAutoStartOn })
        }
        onStartBackend={() => {
          void startBackend()
        }}
        onStopBackend={() => {
          void stopBackend()
        }}
        uptimeMs={uptimeMs}
      />
      <VmoStatusCard
        isAutoStartOn={settings.runtime.autoStartVmo}
        onIsAutoStartOnChange={(isAutoStartOn) =>
          onRuntimeChange({ autoStartVmo: isAutoStartOn })
        }
        onStartVmo={() => {
          void startVmo()
        }}
        onStopVmo={() => {
          void stopVmo()
        }}
        vmoServerInfo={vmoServerInfo}
      />
      <StartupSwitchSaveStatus autoStartSave={runtimeAutoStartSave} />
    </>
  )
}

/**
 * Presents the provider connections card and, under it, the card of the
 * model a new conversation uses, with the model request feedback.
 *
 * @remarks The application store owns the backend and provider statuses, the
 * saved providers and default model, the connect, load, and unload commands,
 * and the pane the settings view shows. Refresh connects again to each
 * provider the card lists; Open Providers shows the Providers pane. Refresh,
 * Load, and Unload intentionally discard their promises with `void`; the
 * store owns each request's completion, and the model request feedback,
 * rendered last in the model card, reports the model requests. The model
 * card shows the session's default model, or without one the first model
 * that can answer, with its provider's inventory and request; with neither,
 * a released provider's. The group renders no host of its own, so each card
 * takes its place in the pane's stack.
 * @returns The provider and model cards.
 */
function ModelRuntimeCardGroup(): ReactElement {
  const backendStatus = useLysStore((state) => state.backendServerInfo.status)
  const providers = useLysStore((state) => state.settings.providers)
  const providerModels = useLysStore((state) => state.providerModels)
  const { model, availability } = useNewConversationModel()
  const connectProvider = useLysStore((state) => state.connectProvider)
  const loadModel = useLysStore((state) => state.loadModel)
  const unloadModel = useLysStore((state) => state.unloadModel)
  const setSettingsPane = useLysStore((state) => state.setSettingsPane)
  const modelProviderModels: Omit<ProviderModelState, "status"> =
    model === null ? RELEASED_PROVIDER_MODELS : providerModels[model.provider]
  const isProviderAvailable =
    model !== null &&
    calculateProviderAvailability(
      { backendStatus, enabledProviders: providers.enabled, providerModels },
      model.provider
    ) === "available"

  /**
   * Connects again to each provider Refresh lists.
   *
   * @param refreshed - Providers to connect to again.
   */
  function handleRefreshProviders(refreshed: readonly LlmProvider[]): void {
    for (const provider of refreshed) void connectProvider(provider)
  }

  return (
    <>
      <ProviderStatusCard
        backendStatus={backendStatus}
        onOpenProviders={() => {
          setSettingsPane("providers")
        }}
        onRefreshProviders={handleRefreshProviders}
        providerModels={providerModels}
        providers={providers}
      />
      <ModelResidencyCard
        availability={availability}
        isProviderAvailable={isProviderAvailable}
        model={model}
        modelInventory={modelProviderModels.inventory}
        modelRequest={modelProviderModels.request}
        onLoadModel={(loaded) => {
          void loadModel(loaded)
        }}
        onUnloadModel={(unloaded) => {
          void unloadModel(unloaded)
        }}
      >
        <ModelRequestFeedback />
      </ModelResidencyCard>
    </>
  )
}

/**
 * Presents the Runtime pane: Lys's backend and vmo with their startup
 * switches, then the turned-on providers and the weights of the model a new
 * conversation uses.
 *
 * @remarks The pane accepts no props and is loaded lazily by the settings
 * view, under the settings context. It owns the stack and the order of its
 * parts: the backend card, the vmo card under it, the save status of both
 * startup switches, the provider connections card, which owns the only
 * reconnect action, and the model card. Each group selects only the
 * application store and settings context state its cards show.
 * @returns The Runtime pane body.
 */
export default function RuntimePaneContent(): ReactElement {
  return (
    <div className="settings-view__stack">
      <ProcessCardGroup />
      <ModelRuntimeCardGroup />
    </div>
  )
}
