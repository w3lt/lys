import type { ReactElement } from "react"

import { Button } from "@/components/ui/button"
import { buildModelDescriptor } from "@/lib/models/inventory"
import { useLysStore } from "@/lib/store"

import ModelRow from "./ModelRow"
import ModelRequestFeedback from "./ModelRequestFeedback"
import { useSettingsContext } from "./SettingsContext"

/**
 * Presents the downloaded inventory and the default-model selection.
 * @returns Backend model rows or an explicit unavailable/empty state.
 * @remarks Requires SettingsContext and the
 * application store. The store owns requests, errors, and inventory; refreshing
 * prevents overlapping actions. Multiple models may be loaded independently.
 */
function ModelInventoryPanel(): ReactElement {
  const backendStatus = useLysStore((state) => state.backendServerInfo.status)
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
  const disabled = backendStatus !== "running" || modelRequest.status !== "idle"
  const models =
    modelInventory.status === "ready"
      ? modelInventory.models.map(buildModelDescriptor)
      : []
  const emptyMessage =
    backendStatus !== "running"
      ? "Start the backend to list models."
      : modelInventory.status === "failed"
        ? "Model inventory is unavailable. Refresh to try again."
        : modelRequest.status === "listing"
          ? "Reading models from LM Studio…"
          : modelInventory.status === "ready"
            ? "No downloaded language models found in LM Studio."
            : "Refresh to list downloaded models."
  return (
    <section className="settings-view__section">
      <div className="settings-view__section-heading">
        <h2>models</h2>
        <Button
          disabled={disabled}
          onClick={() => void onRefreshModels()}
          size="sm"
          type="button"
          variant="outline"
        >
          Refresh
        </Button>
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
        <p className="settings-view__note">{emptyMessage}</p>
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
