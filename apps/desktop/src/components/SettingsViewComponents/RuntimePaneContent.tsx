import type { ReactElement } from "react"
import BackendStatusCard from "./BackendStatusCard"
import LmStudioStatusCard from "./LmStudioStatusCard"
import ModelRequestFeedback from "./ModelRequestFeedback"
import ModelResidencyCard from "./ModelResidencyCard"
import StartupSwitchSaveStatus from "./StartupSwitchSaveStatus"
import VmoStatusCard from "./VmoStatusCard"
import { useBackendUptimeMs } from "@/lib/hooks/backendRuntime"
import { calculateModelRuntimeAvailability } from "@/lib/models/lm-studio-connection"
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
 * Presents the LM Studio card and, under it, the model card with the model
 * request feedback.
 *
 * @remarks The application store owns the backend and LM Studio status and
 * the LM Studio connect command; the settings context owns the default
 * model, the model state, and the load and unload requests, and must be
 * provided. Refresh, Load, and Unload intentionally discard their promises
 * with `void`; their stores own each request's completion, and the model
 * request feedback, rendered last in the model card, reports the model
 * requests. The group renders no host of its own, so each card takes its
 * place in the pane's stack.
 * @returns The LM Studio and model cards.
 */
function ModelRuntimeCardGroup(): ReactElement {
  const backendStatus = useLysStore((state) => state.backendServerInfo.status)
  const lmStudioStatus = useLysStore((state) => state.lmStudioStatus)
  const connectLmStudio = useLysStore((state) => state.connectLmStudio)
  const {
    settings,
    modelRuntime,
    modelRequest,
    modelInventory,
    onLoadModel,
    onUnloadModel
  } = useSettingsContext()
  const availability = calculateModelRuntimeAvailability(
    backendStatus,
    lmStudioStatus
  )

  return (
    <>
      <LmStudioStatusCard
        backendStatus={backendStatus}
        lmStudioStatus={lmStudioStatus}
        onRefreshLmStudioStatus={() => {
          void connectLmStudio()
        }}
      />
      <ModelResidencyCard
        availability={availability}
        defaultModel={settings.runtime.defaultModel}
        modelInventory={modelInventory}
        modelRequest={modelRequest}
        modelRuntime={modelRuntime}
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
 * switches, then LM Studio and the model weights.
 *
 * @remarks The pane accepts no props and is loaded lazily by the settings
 * view, under the settings context. It owns the stack and the order of its
 * parts: the backend card, the vmo card under it, the save status of both
 * startup switches, the LM Studio card, which owns the only reconnect
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
