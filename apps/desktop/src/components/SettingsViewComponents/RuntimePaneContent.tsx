import type { ReactElement } from "react"
import BackendStatusCard from "./BackendStatusCard"
import LmStudioStatusCard from "./LmStudioStatusCard"
import ModelRequestFeedback from "./ModelRequestFeedback"
import ModelResidencyCard from "./ModelResidencyCard"
import StartupSwitchSaveStatus from "./StartupSwitchSaveStatus"
import VmoStatusCard from "./VmoStatusCard"
import { useBackendUptimeMs } from "@/lib/hooks/backendRuntime"
import { describeLlmProviderTarget } from "@/lib/models/llm-provider-target"
import { useLysStore } from "@/lib/store"

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
 * Presents the shown provider's card and, under it, the card of the model a
 * new conversation uses, with the model request feedback.
 *
 * @remarks The application store owns the backend and provider status and
 * the connect command; the settings context owns the shown provider, the
 * model a new conversation uses, the shown provider's model state, and the
 * load and unload requests, and must be provided. Refresh, Load, and Unload intentionally discard their promises
 * with `void`; their stores own each request's completion, and the model
 * request feedback, rendered last in the model card, reports the model
 * requests. The group renders no host of its own, so each card takes its
 * place in the pane's stack.
 * @returns The provider and model cards.
 */
function ModelRuntimeCardGroup(): ReactElement {
  const backendStatus = useLysStore((state) => state.backendServerInfo.status)
  const {
    settings,
    shownProvider,
    providerAvailability,
    newConversationModel,
    modelRequest,
    modelInventory,
    onLoadModel,
    onUnloadModel
  } = useSettingsContext()
  const providerStatus = useLysStore(
    (state) => state.providerModels[shownProvider].status
  )
  const connectProvider = useLysStore((state) => state.connectProvider)
  const provider = describeLlmProviderTarget(shownProvider, settings.providers)

  return (
    <>
      <LmStudioStatusCard
        backendStatus={backendStatus}
        onRefreshStatus={() => {
          void connectProvider(shownProvider)
        }}
        provider={provider}
        status={providerStatus}
      />
      <ModelResidencyCard
        availability={newConversationModel.availability}
        model={newConversationModel.model}
        modelInventory={modelInventory}
        modelRequest={modelRequest}
        provider={provider}
        providerAvailability={providerAvailability}
        onLoadModel={(modelKey) => {
          void onLoadModel(modelKey)
        }}
        onUnloadModel={(modelKey) => {
          void onUnloadModel(modelKey)
        }}
      >
        <ModelRequestFeedback />
      </ModelResidencyCard>
    </>
  )
}

/**
 * Presents the Runtime pane: Lys's backend and vmo with their startup
 * switches, then the shown provider and the model weights.
 *
 * @remarks The pane accepts no props and is loaded lazily by the settings
 * view, under the settings context. It owns the stack and the order of its
 * parts: the backend card, the vmo card under it, the save status of both
 * startup switches, the shown provider's card, which owns the only reconnect
 * action, and the model card. Each group selects only the application store
 * and settings context state its cards show.
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
