import { useId, type ReactElement } from "react"

import { Button } from "@/components/ui/button"
import { Tooltip } from "@/components/ui/tooltip"
import { buildModelDescriptor } from "@/lib/models/inventory"
import { isSameLlmModelReference } from "@lys/share"
import {
  formatProviderUnreachableMessage,
  type ProviderAvailability
} from "@/lib/models/provider-connection"
import {
  describeLlmProviderTarget,
  type LlmProviderTarget
} from "@/lib/models/llm-provider-target"
import {
  readObservedModelLoading,
  type ModelInventoryState,
  type ModelRequestState,
  type ObservedModelLoading
} from "@/lib/store/model-runtime"

import ModelLoadConfigurationPanel from "./ModelLoadConfigurationPanel"
import ModelRow from "./ModelRow"
import ModelRequestFeedback from "./ModelRequestFeedback"
import { useSettingsContext } from "./SettingsContext"

/**
 * Formats the empty-state explanation for the model inventory.
 *
 * @param availability - Whether model requests can reach the shown
 * provider, and why not.
 * @param inventoryStatus - Latest inventory observation status.
 * @param requestStatus - Current model request status.
 * @param provider - Shown provider, which the explanation names.
 * @returns The first applicable reason, checked in order: the backend is not
 * running, the provider is off, the provider is connecting, the provider is
 * not reachable, the inventory read failed, models are being listed, the
 * provider has no language models, or the inventory has not been read yet.
 */
function formatModelInventoryEmptyMessage(
  availability: ProviderAvailability,
  inventoryStatus: ModelInventoryState["status"],
  requestStatus: ModelRequestState["status"],
  provider: LlmProviderTarget
): string {
  if (availability === "backend-offline") {
    return "Start the backend to list models."
  }
  if (availability === "provider-off") {
    return `${provider.name} is off. Turn it on in Providers to list its models.`
  }
  if (availability === "provider-connecting") {
    return `Connecting to ${provider.name}…`
  }
  if (availability === "provider-unreachable") {
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
 * Formats the note under the model list.
 *
 * @param modelLoading - Who loads the models, as the inventory reports.
 * @param provider - Shown provider, which the note names.
 * @returns How choosing and testing a row work, and who loads the models,
 * with where to start a model the provider is not running; nothing about
 * loading while no inventory has been read.
 */
function formatModelInventoryNote(
  modelLoading: ObservedModelLoading,
  provider: LlmProviderTarget
): string {
  switch (modelLoading) {
    case "lys":
      return `Choosing a row sets the default for this session. Load and Unload update ${provider.name}. Test checks loaded state; it does not generate a response.`
    case "provider":
      return `Choosing a row sets the default for this session. ${provider.name} decides which models are in memory: a model it is not running answers once you start it in ${provider.name}. Test checks loaded state; it does not generate a response.`
    case "unknown":
      return "Choosing a row sets the default for this session. Test checks loaded state; it does not generate a response."
  }
}

/**
 * Presents the shown provider's downloaded inventory and the default-model
 * selection.
 * @returns A heading naming the provider, then backend model rows or an
 * explicit unavailable/empty state.
 * @remarks Requires SettingsContext and the
 * application store. The store owns requests, errors, and inventory; refreshing
 * prevents overlapping actions. Multiple models may be loaded independently.
 * Model actions require a running backend and a connected provider; Load and
 * Unload appear only while the inventory reports that Lys loads the models. While
 * the provider is not reachable the list is empty, Refresh is disabled, and a
 * pointer tooltip plus `aria-describedby` repeat the empty-state explanation.
 */
function ModelInventoryPanel(): ReactElement {
  const emptyMessageId = useId()
  const {
    settings,
    shownProvider,
    providerAvailability: availability,
    modelInventory,
    modelRequest,
    onRuntimeChange,
    onLoadModel,
    onUnloadModel,
    onTestModel,
    onRefreshModels
  } = useSettingsContext()
  const provider = describeLlmProviderTarget(shownProvider, settings.providers)
  const { defaultModel } = settings.runtime
  const modelLoading = readObservedModelLoading(modelInventory)
  const isProviderUnreachable = availability === "provider-unreachable"
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
      aria-describedby={isProviderUnreachable ? emptyMessageId : undefined}
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
        <h2>{`models · ${provider.name}`}</h2>
        {isProviderUnreachable ? (
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
            provider={shownProvider}
            model={model}
            isDefault={
              defaultModel !== null &&
              isSameLlmModelReference(defaultModel, {
                provider: shownProvider,
                modelKey: model.modelKey
              })
            }
            modelRequest={modelRequest}
            onSelect={(modelKey) =>
              onRuntimeChange({
                defaultModel: { provider: shownProvider, modelKey }
              })
            }
            disabled={disabled}
            modelLoading={modelLoading}
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
        {formatModelInventoryNote(modelLoading, provider)}
      </p>
    </section>
  )
}

/**
 * Composes the backend-backed model inventory and, while the inventory
 * reports that Lys loads the models, the load configuration of the model
 * being edited.
 * @returns The model list with its operations, then the load configuration.
 * @remarks Children share SettingsContext;
 * the application store owns request lifetime and handles asynchronous failures.
 * A provider that loads its models itself takes no load configuration, and
 * none is offered before an inventory says who loads the models.
 */
export default function ModelPaneContent(): ReactElement {
  const { modelInventory } = useSettingsContext()
  return (
    <div className="settings-view__stack">
      <ModelInventoryPanel />
      {modelInventory.status === "ready" &&
      modelInventory.modelLoading === "lys" ? (
        <ModelLoadConfigurationPanel models={modelInventory.models} />
      ) : null}
    </div>
  )
}
