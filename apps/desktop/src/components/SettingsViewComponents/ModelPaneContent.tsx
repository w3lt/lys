import { useId, type ReactElement } from "react"

import { Button } from "@/components/ui/button"
import { Tooltip } from "@/components/ui/tooltip"
import { buildModelDescriptor } from "@/lib/models/inventory"
import {
  calculateModelRuntimeAvailability,
  LM_STUDIO_UNREACHABLE_MESSAGE,
  type ModelRuntimeAvailability
} from "@/lib/models/lm-studio-connection"
import { useLysStore } from "@/lib/store"
import type {
  ModelInventoryState,
  ModelRequestState
} from "@/lib/store/model-runtime"

import ModelRow from "./ModelRow"
import ModelRequestFeedback from "./ModelRequestFeedback"
import { useSettingsContext } from "./SettingsContext"

/**
 * Formats the empty-state explanation for the model inventory.
 *
 * @param availability - Whether model requests can reach LM Studio, and why not.
 * @param inventoryStatus - Latest inventory observation status.
 * @param requestStatus - Current model request status.
 * @returns The first applicable reason, checked in order: the backend is not
 * running, LM Studio is connecting, LM Studio is not reachable, the inventory
 * read failed, models are being listed, LM Studio has no downloaded language
 * models, or the inventory has not been read yet.
 */
function formatModelInventoryEmptyMessage(
  availability: ModelRuntimeAvailability,
  inventoryStatus: ModelInventoryState["status"],
  requestStatus: ModelRequestState["status"]
): string {
  if (availability === "backend-offline") {
    return "Start the backend to list models."
  }
  if (availability === "lm-studio-connecting") {
    return "Connecting to LM Studio…"
  }
  if (availability === "lm-studio-unreachable") {
    return LM_STUDIO_UNREACHABLE_MESSAGE
  }
  if (inventoryStatus === "failed") {
    return "Model inventory is unavailable. Refresh to try again."
  }
  if (requestStatus === "listing") return "Reading models from LM Studio…"
  if (inventoryStatus === "ready") {
    return "No downloaded language models found in LM Studio."
  }
  return "Refresh to list downloaded models."
}

/**
 * Presents the downloaded inventory and the default-model selection.
 * @returns Backend model rows or an explicit unavailable/empty state.
 * @remarks Requires SettingsContext and the
 * application store. The store owns requests, errors, and inventory; refreshing
 * prevents overlapping actions. Multiple models may be loaded independently.
 * Model actions require a running backend and a connected LM Studio. While LM
 * Studio is not reachable the list is empty, Refresh is disabled, and a
 * pointer tooltip plus `aria-describedby` repeat the empty-state explanation.
 */
function ModelInventoryPanel(): ReactElement {
  const backendStatus = useLysStore((state) => state.backendServerInfo.status)
  const lmStudioStatus = useLysStore((state) => state.lmStudioStatus)
  const emptyMessageId = useId()
  const {
    settings,
    modelInventory,
    modelRequest,
    modelRuntime,
    onRuntimeChange,
    onLoadModel,
    onUnloadModel,
    onTestModel,
    onRefreshModels
  } = useSettingsContext()
  const availability = calculateModelRuntimeAvailability(
    backendStatus,
    lmStudioStatus
  )
  const isLmStudioUnreachable = availability === "lm-studio-unreachable"
  const disabled =
    availability !== "available" || modelRequest.status !== "idle"
  const models =
    modelInventory.status === "ready"
      ? modelInventory.models.map(buildModelDescriptor)
      : []
  const emptyMessage = formatModelInventoryEmptyMessage(
    availability,
    modelInventory.status,
    modelRequest.status
  )
  const refreshButton = (
    <Button
      aria-describedby={isLmStudioUnreachable ? emptyMessageId : undefined}
      disabled={disabled}
      onClick={() => void onRefreshModels()}
      size="sm"
      type="button"
      variant="outline"
    >
      Refresh
    </Button>
  )
  return (
    <section className="settings-view__section">
      <div className="settings-view__section-heading">
        <h2>models</h2>
        {isLmStudioUnreachable ? (
          <Tooltip description={LM_STUDIO_UNREACHABLE_MESSAGE}>
            {refreshButton}
          </Tooltip>
        ) : (
          refreshButton
        )}
      </div>
      <ul
        className="settings-view__model-list"
        aria-label="Downloaded models"
        aria-busy={modelRequest.status !== "idle"}
      >
        {models.map((model) => (
          <ModelRow
            key={model.modelKey}
            model={model}
            isDefault={model.modelKey === settings.runtime.defaultModel}
            modelRuntime={modelRuntime}
            onSelect={(modelKey) => onRuntimeChange({ defaultModel: modelKey })}
            disabled={disabled}
            onLoad={onLoadModel}
            onUnload={onUnloadModel}
            onTest={onTestModel}
          />
        ))}
      </ul>
      {models.length === 0 ? (
        <p className="settings-view__note" id={emptyMessageId}>
          {emptyMessage}
        </p>
      ) : null}
      <ModelRequestFeedback />
      <p className="settings-view__note">
        Choosing a row sets the default for this session. Load and Unload update
        LM Studio. Test checks loaded state; it does not generate a response.
      </p>
    </section>
  )
}

/**
 * Explains the current backend limit on context configuration.
 * @returns The retained local context budget and its application boundary.
 * @remarks Requires SettingsContext. The
 * current load API accepts only modelId, so no load-time control is offered.
 */
function ModelLoadConfiguration(): ReactElement {
  const { settings } = useSettingsContext()
  return (
    <section className="settings-view__section">
      <div className="settings-view__section-heading">
        <h2>load configuration</h2>
        <span>managed by LM Studio</span>
      </div>
      <div className="settings-view__row">
        <div className="settings-view__identity-lines">
          <h3>Context size</h3>
          <p>
            The backend uses LM Studio's load defaults. Context-size overrides
            are not supported yet.
          </p>
        </div>
        <span>
          {settings.model.contextSize.toLocaleString()} tokens · local estimate
        </span>
      </div>
    </section>
  )
}

/**
 * Composes the backend-backed model inventory and load-configuration boundary.
 * @returns Model settings with real operations and truthful capability limits.
 * @remarks Children share SettingsContext;
 * the application store owns request lifetime and handles asynchronous failures.
 */
export default function ModelPaneContent(): ReactElement {
  return (
    <div className="settings-view__stack">
      <ModelInventoryPanel />
      <ModelLoadConfiguration />
    </div>
  )
}
