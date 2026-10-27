import { useId, type ReactElement } from "react"

import { Button } from "@/components/ui/button"
import { Tooltip } from "@/components/ui/tooltip"
import { buildModelDescriptor } from "@/lib/models/inventory"
import {
  calculateModelRuntimeAvailability,
  formatProviderUnreachableMessage,
  type ModelRuntimeAvailability
} from "@/lib/models/lm-studio-connection"
import {
  describeLlmProviderTarget,
  type LlmProviderTarget
} from "@/lib/models/llm-provider-target"
import { useLysStore } from "@/lib/store"
import type {
  ModelInventoryState,
  ModelRequestState
} from "@/lib/store/model-runtime"

import ModelLoadConfigurationPanel from "./ModelLoadConfigurationPanel"
import ModelRow from "./ModelRow"
import ModelRequestFeedback from "./ModelRequestFeedback"
import { useSettingsContext } from "./SettingsContext"

/**
 * Formats the empty-state explanation for the model inventory.
 *
 * @param availability - Whether model requests can reach the active
 * provider, and why not.
 * @param inventoryStatus - Latest inventory observation status.
 * @param requestStatus - Current model request status.
 * @param provider - Active provider, which the explanation names.
 * @returns The first applicable reason, checked in order: the backend is not
 * running, the provider is connecting, the provider is not reachable, the
 * inventory read failed, models are being listed, the provider has no language
 * models, or the inventory has not been read yet.
 */
function formatModelInventoryEmptyMessage(
  availability: ModelRuntimeAvailability,
  inventoryStatus: ModelInventoryState["status"],
  requestStatus: ModelRequestState["status"],
  provider: LlmProviderTarget
): string {
  if (availability === "backend-offline") {
    return "Start the backend to list models."
  }
  if (availability === "lm-studio-connecting") {
    return `Connecting to ${provider.name}…`
  }
  if (availability === "lm-studio-unreachable") {
    return formatProviderUnreachableMessage(provider)
  }
  if (inventoryStatus === "failed") {
    return "Model inventory is unavailable. Refresh to try again."
  }
  if (requestStatus === "listing") {
    return `Reading models from ${provider.name}…`
  }
  if (inventoryStatus === "ready") {
    return provider.access === "address"
      ? `No downloaded language models found in ${provider.name}.`
      : `No language models found in ${provider.name}.`
  }
  return "Refresh to list models."
}

/**
 * Presents the downloaded inventory and the default-model selection.
 * @returns Backend model rows or an explicit unavailable/empty state.
 * @remarks Requires SettingsContext and the
 * application store. The store owns requests, errors, and inventory; refreshing
 * prevents overlapping actions. Multiple models may be loaded independently.
 * Model actions require a running backend and a connected provider; Load and
 * Unload appear only while Lys manages the provider's model loading. While
 * the provider is not reachable the list is empty, Refresh is disabled, and a
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
  const provider = describeLlmProviderTarget(settings.providers)
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
    modelRequest.status,
    provider
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
          <Tooltip description={formatProviderUnreachableMessage(provider)}>
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
            isModelLoadingManaged={provider.managesModelLoading}
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
        {provider.managesModelLoading
          ? `Choosing a row sets the default for this session. Load and Unload update ${provider.name}. Test checks loaded state; it does not generate a response.`
          : `Choosing a row sets the default for this session. ${provider.name} decides which models are in memory. Test checks loaded state; it does not generate a response.`}
      </p>
    </section>
  )
}

/**
 * Composes the backend-backed model inventory and, while Lys manages the
 * active provider's model loading, the load configuration of the model being
 * edited.
 * @returns The model list with its operations, then the load configuration.
 * @remarks Children share SettingsContext;
 * the application store owns request lifetime and handles asynchronous failures.
 * A provider that loads its models itself takes no load configuration.
 */
export default function ModelPaneContent(): ReactElement {
  const { settings } = useSettingsContext()
  const provider = describeLlmProviderTarget(settings.providers)
  return (
    <div className="settings-view__stack">
      <ModelInventoryPanel />
      {provider.managesModelLoading ? <ModelLoadConfigurationPanel /> : null}
    </div>
  )
}
