import type { ReactElement } from "react"
import type { LlmInfo } from "@lys/protocol"
import type { LlmProvider } from "@lys/share"

import {
  describeLlmProviderTarget,
  isLlmProviderKeyMissing
} from "@/lib/models/llm-provider-target"
import {
  calculateProviderAvailability,
  listEnabledProviders,
  type ModelAvailabilitySource
} from "@/lib/models/provider-connection"
import { useLysStore } from "@/lib/store"
import type { ModelInventoryState } from "@/lib/store/model-runtime"
import type { LysSettings } from "@/lib/store/settings"

import ModelDefaultSummary from "./ModelDefaultSummary"
import ModelDetails from "./ModelDetails"
import ModelInventoryNotice from "./ModelInventoryNotice"
import ModelList from "./ModelList"
import ModelProviderCard from "./ModelProviderCard"
import {
  buildModelProviderSummary,
  calculateModelContextLength,
  describeInventoryEmptyState,
  describeModelPaneProvider,
  describeProviderEmptyState,
  findListedModel,
  findModelPaneModelKey,
  findModelPaneProvider,
  formatModelRefreshNote,
  type ModelPaneChoiceSource,
  type ModelPaneEmptyState,
  type ModelProviderSummary
} from "./model-pane-presentation"
import { useSettingsContext } from "./SettingsContext"

/** Shown when no provider is on, so no models can be listed. */
const NO_PROVIDER_STATE: ModelPaneEmptyState = Object.freeze({
  title: "No provider is on.",
  body: "Turn one on in Providers to see its models.",
  settingsPane: "providers"
})

/** Shown while a reachable provider's inventory has not been read. */
const UNREAD_INVENTORY_STATE: ModelPaneEmptyState = Object.freeze({
  title: "Refresh to list models.",
  body: "",
  settingsPane: null
})

/**
 * Builds the summaries of every provider that is on.
 *
 * @param settings - Current settings.
 * @param source - Backend status and every provider's model state.
 * @returns One summary for each provider that is on, in provider order.
 */
function listModelProviderSummaries(
  settings: LysSettings,
  source: ModelAvailabilitySource
): readonly ModelProviderSummary[] {
  return listEnabledProviders(settings.providers.enabled).map((provider) =>
    buildModelProviderSummary(
      describeLlmProviderTarget(provider, settings.providers),
      calculateProviderAvailability(source, provider),
      source.providerModels[provider].inventory,
      settings.runtime.defaultModel
    )
  )
}

/**
 * Calculates the context length the session's default model is shown with.
 *
 * @param settings - Current settings.
 * @param source - Every provider's model state.
 * @returns The default model's context length, or null when there is no
 * default or its provider does not list it now.
 */
function findDefaultModelContextLength(
  settings: LysSettings,
  source: ModelAvailabilitySource
): number | null {
  const { defaultModel } = settings.runtime
  if (defaultModel === null) return null
  const { inventory } = source.providerModels[defaultModel.provider]
  const model = findListedModel(inventory, defaultModel.modelKey)
  if (model === undefined) return null
  return calculateModelContextLength(
    defaultModel.provider,
    model,
    settings.loadConfiguration
  )
}

/** Properties accepted by {@link ModelBrowser}. */
type ModelBrowserProps = {
  /** Provider whose models are listed. */
  readonly provider: LlmProvider
  /** Models its inventory lists; at least one. */
  readonly models: readonly LlmInfo[]
  /** Whether Lys loads and unloads the provider's models. */
  readonly canLoadModels: boolean
  /** The pane's and the session's choices of provider and model. */
  readonly choice: ModelPaneChoiceSource
}

/**
 * Lists one provider's models beside the details of the selected one.
 *
 * @remarks The application store holds the
 * pane's selection. Pressing a row selects its model. The list is remounted
 * for another provider, which clears its filter, and the details for
 * another model.
 * @param props - Provider, its models, whether Lys loads them, and the
 * choices that select one.
 * @returns The list and the selected model's details, or a request to
 * choose one.
 */
function ModelBrowser({
  provider,
  models,
  canLoadModels,
  choice
}: ModelBrowserProps): ReactElement {
  const setModelPaneSelection = useLysStore(
    (state) => state.setModelPaneSelection
  )
  const request = useLysStore((state) => state.providerModels[provider].request)
  const modelKey = findModelPaneModelKey(provider, choice, models)
  const model = models.find((candidate) => candidate.modelKey === modelKey)
  const { defaultModel } = choice
  return (
    <div className="settings-view__models-browser">
      <ModelList
        defaultModelKey={
          defaultModel?.provider === provider ? defaultModel.modelKey : null
        }
        key={provider}
        loadingModelKey={request.status === "loading" ? request.modelKey : null}
        models={models}
        onSelectModel={(key) =>
          setModelPaneSelection({ provider, modelKey: key })
        }
        provider={provider}
        selectedModelKey={modelKey}
      />
      {model === undefined ? (
        <p className="settings-view__models-unselected">
          Choose a model to see its status and load settings.
        </p>
      ) : (
        <ModelDetails
          canLoadModels={canLoadModels}
          key={`${provider}/${model.modelKey}`}
          model={model}
          provider={provider}
        />
      )}
    </div>
  )
}

/** Properties accepted by {@link ModelProviderInventory}. */
type ModelProviderInventoryProps = {
  /** Provider the pane shows. */
  readonly provider: LlmProvider
  /** Its latest inventory observation. */
  readonly inventory: ModelInventoryState
  /** Why none of its models are listed, or null while they can be. */
  readonly notice: ModelPaneEmptyState | null
  /** The pane's and the session's choices of provider and model. */
  readonly choice: ModelPaneChoiceSource
}

/**
 * Shows the shown provider's models with the selected one's details, or
 * why none are listed.
 *
 * @remarks Requires the application store, whose settings
 * pane the notice's button opens. The models show only while there is no
 * notice and the inventory is read; an inventory not yet read asks for a
 * refresh.
 * @param props - Provider, its inventory, the notice, and the choices.
 * @returns The list and details, or the notice.
 */
function ModelProviderInventory({
  provider,
  inventory,
  notice,
  choice
}: ModelProviderInventoryProps): ReactElement {
  const setSettingsPane = useLysStore((state) => state.setSettingsPane)
  if (notice === null && inventory.status === "ready") {
    return (
      <ModelBrowser
        canLoadModels={inventory.modelLoading === "lys"}
        choice={choice}
        models={inventory.models}
        provider={provider}
      />
    )
  }
  return (
    <ModelInventoryNotice
      onOpenSettingsPane={setSettingsPane}
      state={notice ?? UNREAD_INVENTORY_STATE}
    />
  )
}

/** Properties accepted by {@link ModelProviderSection}. */
type ModelProviderSectionProps = {
  /** Provider the pane shows. */
  readonly provider: LlmProvider
  /** The pane's and the session's choices of provider and model. */
  readonly choice: ModelPaneChoiceSource
  /** Backend status and every provider's model state. */
  readonly source: ModelAvailabilitySource
}

/**
 * Shows the pane's provider card, then its models or why there are none.
 *
 * @remarks Requires SettingsContext and the application
 * store. Choosing another provider in the card clears the pane's selected
 * model, so that provider shows the session's default when the default is
 * one of its models, and no selected model otherwise. Refresh reads the
 * inventory of a connected provider again and asks the backend to connect
 * to one that cannot be reached; it is disabled while the provider's
 * request runs, while it connects, and while the backend is not running.
 * The provider's latest request failure is an alert.
 * @param props - Shown provider, the choices, and the model state.
 * @returns The provider card, the list and details or a notice, and the
 * failure alert.
 */
function ModelProviderSection({
  provider,
  choice,
  source
}: ModelProviderSectionProps): ReactElement {
  const { settings } = useSettingsContext()
  const setModelPaneProvider = useLysStore(
    (state) => state.setModelPaneProvider
  )
  const updateModelInventory = useLysStore(
    (state) => state.updateModelInventory
  )
  const connectProvider = useLysStore((state) => state.connectProvider)
  const target = describeLlmProviderTarget(provider, settings.providers)
  const availability = calculateProviderAvailability(source, provider)
  const { inventory, request, error, settledAt } =
    source.providerModels[provider]
  const isKeyMissing = isLlmProviderKeyMissing(provider, settings.secrets)
  const canRefresh =
    availability === "available" || availability === "provider-unreachable"

  /** Reads a connected provider's models again, or reconnects to it. */
  function handleRefreshProvider(): void {
    if (availability === "available") void updateModelInventory(provider)
    else void connectProvider(provider)
  }

  return (
    <>
      <ModelProviderCard
        choices={listModelProviderSummaries(settings, source)}
        isRefreshDisabled={!canRefresh || request.status !== "idle"}
        isRefreshing={request.status === "listing"}
        note={describeModelPaneProvider(provider).note}
        onRefreshProvider={handleRefreshProvider}
        onShownProviderChange={setModelPaneProvider}
        refreshNote={formatModelRefreshNote(request, settledAt, target.name)}
        shown={buildModelProviderSummary(
          target,
          availability,
          inventory,
          choice.defaultModel
        )}
      />
      <ModelProviderInventory
        choice={choice}
        inventory={inventory}
        notice={
          describeProviderEmptyState(availability, target, isKeyMissing) ??
          describeInventoryEmptyState(inventory, request, target)
        }
        provider={provider}
      />
      <p className="settings-view__models-alert" role="alert">
        {error}
      </p>
    </>
  )
}

/**
 * Composes the Models pane: the session's default, a provider picker, and
 * the chosen provider's models with the selected model's details.
 *
 * @remarks Requires SettingsContext and the application
 * store, which owns every provider's models, requests, and failures, and
 * the pane's selection, kept across visits to settings. The pane shows the
 * selected model's provider, else the provider the picker chose, else the
 * default model's provider, else the first provider that is on; the
 * selected model is the one the pane was asked to show, else the default.
 * Pressing the default model's key selects it, while its provider is on.
 * With no provider on, a notice links to Providers.
 * @returns The pane body.
 */
export default function ModelPaneContent(): ReactElement {
  const { settings } = useSettingsContext()
  const backendStatus = useLysStore((state) => state.backendServerInfo.status)
  const providerModels = useLysStore((state) => state.providerModels)
  const selection = useLysStore((state) => state.modelPaneSelection)
  const chosenProvider = useLysStore((state) => state.modelPaneProvider)
  const setModelPaneSelection = useLysStore(
    (state) => state.setModelPaneSelection
  )
  const setSettingsPane = useLysStore((state) => state.setSettingsPane)
  const enabledProviders = settings.providers.enabled
  const { defaultModel } = settings.runtime
  const source = { backendStatus, enabledProviders, providerModels }
  const choice = { enabledProviders, selection, chosenProvider, defaultModel }
  const provider = findModelPaneProvider(choice)
  return (
    <div className="settings-view__models">
      <ModelDefaultSummary
        contextLength={findDefaultModelContextLength(settings, source)}
        defaultModel={defaultModel}
        isProviderOn={
          defaultModel !== null &&
          enabledProviders.includes(defaultModel.provider)
        }
        onSelectDefaultModel={() => setModelPaneSelection(defaultModel)}
      />
      {provider === null ? (
        <ModelInventoryNotice
          onOpenSettingsPane={setSettingsPane}
          state={NO_PROVIDER_STATE}
        />
      ) : (
        <ModelProviderSection
          choice={choice}
          provider={provider}
          source={source}
        />
      )}
    </div>
  )
}
