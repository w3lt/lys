import type { ReactElement } from "react"
import ModelRequestFeedback from "./ModelRequestFeedback"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import {
  backendStatusLabel,
  backendStatusTone,
  formatUptime,
  useBackendUptimeMs
} from "@/lib/hooks/backendRuntime"
import {
  formatModelResidencyHeading,
  formatModelResidencyMeta,
  readLoadedModelKey,
  readModelResidencyTone
} from "@/lib/models/model-residency"
import { type BackendServerStatus, useLysStore } from "@/lib/store"
import { isModelTransitionInFlight } from "@/lib/store/model-runtime"

import { useSettingsContext } from "./SettingsContext"

/**
 * Formats the address and lifecycle detail shown under the backend status.
 *
 * @param status - Store-owned backend lifecycle state.
 * @param backendAddress - Persisted backend origin.
 * @param uptimeMs - Current process uptime in milliseconds.
 * @returns The visible address and lifecycle detail line.
 */
function formatBackendMeta(
  status: BackendServerStatus,
  backendAddress: string,
  uptimeMs: number
): string {
  switch (status) {
    case "running":
      return `${backendAddress} · up ${formatUptime(uptimeMs)}`
    case "starting":
      return `${backendAddress} · starting`
    case "stopping":
      return `${backendAddress} · stopping`
    case "stopped":
      return `${backendAddress} · not running`
  }
}

/**
 * Presents backend lifecycle controls, autostart, and model residency.
 *
 * @remarks Primary category: composition/view. The application store owns
 * backend status and the start/stop commands; the settings context owns the
 * persisted settings and the model lifecycle requests. Start and Stop
 * intentionally discard their command promises with `void`: failures are not
 * awaited or rendered here, so a rejection surfaces as an unhandled rejection
 * and backend status is not a completion owner when a command rejects. The
 * autostart switch proposes one patch per checked change.
 *
 * The model card projects the settings context's residency state. While a
 * transition is in flight the card is marked busy and carries an indeterminate
 * progress indicator: the API reports completion without progress, so no percentage is
 * claimed. Both lifecycle actions are withheld during a transition, and Load
 * additionally requires a running backend and a chosen default model.
 *
 * @returns The runtime backend and model cards.
 */
export default function RuntimePaneContent(): ReactElement {
  const backendServerInfo = useLysStore((state) => state.backendServerInfo)
  const startBackend = useLysStore((state) => state.startBackend)
  const stopBackend = useLysStore((state) => state.stopBackend)
  const uptimeMs = useBackendUptimeMs()
  const {
    settings,
    modelRuntime,
    modelRequest,
    modelInventory,
    onRuntimeChange,
    onLoadModel,
    onUnloadModel
  } = useSettingsContext()

  const backendStatus = backendServerInfo.status
  const isRunning = backendStatus === "running"
  const autoStart = settings.runtime.autoStartBackend
  const defaultModel = settings.runtime.defaultModel
  const loadedModelKey = readLoadedModelKey(modelRuntime)
  const isTransitioning = isModelTransitionInFlight(modelRuntime)
  const isModelBusy = modelRequest.status !== "idle"
  const defaultEntry =
    modelInventory.status === "ready"
      ? modelInventory.models.find((model) => model.modelKey === defaultModel)
      : undefined
  const residencyHeading = formatModelResidencyHeading(modelRuntime)

  return (
    <div className="settings-view__stack">
      <section className="settings-view__card">
        <div className="settings-view__card-row">
          <div className="settings-view__identity">
            <span
              aria-hidden="true"
              className="settings-view__status-dot"
              data-tone={backendStatusTone(backendStatus)}
            />
            <div className="settings-view__identity-lines">
              <h2>{backendStatusLabel(backendStatus)}</h2>
              <p className="settings-view__meta">
                {formatBackendMeta(
                  backendStatus,
                  settings.runtime.backendAddress,
                  uptimeMs
                )}
              </p>
            </div>
          </div>
          <div className="settings-view__actions">
            <Button
              disabled={backendStatus !== "stopped"}
              onClick={() => {
                void startBackend()
              }}
              type="button"
              variant={backendStatus === "stopped" ? "default" : "outline"}
            >
              Start
            </Button>
            <Button
              disabled={!isRunning}
              onClick={() => {
                void stopBackend()
              }}
              type="button"
              variant="outline"
            >
              Stop
            </Button>
          </div>
        </div>

        <div className="settings-view__card-divider" />

        <div className="settings-view__card-row">
          <div className="settings-view__identity-lines">
            <h2>Start it when Lys opens</h2>
            <p>Off means the first thing you do here is press start.</p>
          </div>
          <div className="settings-view__toggle-state">
            {/* The switch already announces its state; this is for the eye. */}
            <span aria-hidden="true">{autoStart ? "on" : "off"}</span>
            <Switch
              aria-label="Start it when Lys opens"
              checked={autoStart}
              onCheckedChange={(checked) =>
                onRuntimeChange({ autoStartBackend: checked })
              }
              size="lg"
            />
          </div>
        </div>
      </section>

      <section
        aria-busy={isTransitioning}
        className="settings-view__card"
        data-dimmed={isRunning ? undefined : ""}
      >
        <div className="settings-view__card-row">
          <div className="settings-view__identity">
            <span
              aria-hidden="true"
              className="settings-view__status-dot"
              data-tone={readModelResidencyTone(modelRuntime)}
            />
            <div className="settings-view__identity-lines">
              <h2>{residencyHeading}</h2>
              <p className="settings-view__meta">
                {formatModelResidencyMeta(
                  modelRuntime,
                  backendStatus,
                  defaultModel
                )}
              </p>
            </div>
          </div>
          <div className="settings-view__actions">
            <Button
              disabled={
                !isRunning ||
                isModelBusy ||
                !defaultEntry ||
                defaultEntry.loaded
              }
              onClick={() => {
                if (defaultModel) void onLoadModel(defaultModel)
              }}
              type="button"
              variant="default"
            >
              Load
            </Button>
            <Button
              disabled={!isRunning || isModelBusy || loadedModelKey === null}
              onClick={() => {
                if (loadedModelKey) void onUnloadModel(loadedModelKey)
              }}
              type="button"
              variant="outline"
            >
              Unload
            </Button>
          </div>
        </div>

        {isTransitioning ? (
          /* The backend acknowledges completion without percentage progress. */
          <div
            aria-label={residencyHeading}
            className="settings-view__progress"
            role="progressbar"
          >
            <span aria-hidden="true" className="settings-view__progress-fill" />
          </div>
        ) : null}

        <div className="settings-view__card-divider" />

        <p className="settings-view__card-note">
          Loading and unloading use LM Studio through the backend. This summary
          prefers the loaded default; manage every loaded model in Model
          settings.
        </p>
        <ModelRequestFeedback />
      </section>
    </div>
  )
}
