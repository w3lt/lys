import type { ReactElement } from "react"
import { Button } from "@/components/ui/button"
import type { ModelRuntimeAvailability } from "@/lib/models/lm-studio-connection"
import type { LlmProviderTarget } from "@/lib/models/llm-provider-target"
import {
  formatModelResidencyHeading,
  formatModelResidencyMeta,
  readLoadedModelKey,
  readModelResidencyTone
} from "@/lib/models/model-residency"
import {
  isModelTransitionInFlight,
  readObservedModelLoading,
  type ModelInventoryState,
  type ModelRequestState,
  type ModelRuntimeState,
  type ObservedModelLoading
} from "@/lib/store/model-runtime"

/**
 * Answers whether a model request can be sent now.
 *
 * @param availability - Whether model requests can reach LM Studio, and why
 * not.
 * @param modelRequest - The model request in flight, if any.
 * @returns Whether LM Studio is connected and no model request is in flight;
 * requests are sent one at a time.
 */
function canSendModelRequest(
  availability: ModelRuntimeAvailability,
  modelRequest: ModelRequestState
): boolean {
  return availability === "available" && modelRequest.status === "idle"
}

/**
 * Finds the default model when it can be loaded.
 *
 * @param modelInventory - The models the backend listed.
 * @param defaultModel - Key of the default model, or null when none is
 * chosen.
 * @returns The default's key while the inventory lists it on disk only, or
 * null: no default, a default the inventory does not list or lists as
 * loaded, or an inventory that is not read.
 */
function findLoadableDefaultModelKey(
  modelInventory: ModelInventoryState,
  defaultModel: string | null
): string | null {
  switch (modelInventory.status) {
    case "unavailable":
    case "failed":
      return null
    case "ready": {
      const defaultEntry = modelInventory.models.find(
        (model) => model.modelKey === defaultModel
      )
      return defaultEntry === undefined || defaultEntry.loaded
        ? null
        : defaultEntry.modelKey
    }
  }
}

/**
 * Formats the card's note.
 *
 * @param modelLoading - Who loads the models, as the inventory reports.
 * @param provider - Active provider, which the note names.
 * @returns That Load and Unload go to the provider through the backend, or
 * that the provider loads its models itself, then where every model is
 * listed; only where every model is listed while no inventory has been read.
 */
function formatModelResidencyNote(
  modelLoading: ObservedModelLoading,
  provider: LlmProviderTarget
): string {
  switch (modelLoading) {
    case "lys":
      return `Loading and unloading use ${provider.name} through the backend. This summary prefers the loaded default; manage every loaded model in Model settings.`
    case "provider":
      return `${provider.name} decides which models are in memory, so Lys does not load or unload them. This summary prefers the default; see every model in Model settings.`
    case "unknown":
      return "This summary prefers the loaded default; see every model in Model settings."
  }
}

/**
 * Builds the click handler of one model command.
 *
 * @param modelKey - Model the command applies to, or null when the command
 * cannot be sent.
 * @param onModelCommand - Requests the command for one model.
 * @returns A handler that requests the command for `modelKey` once per
 * click, or undefined without a model, whose button is disabled.
 */
function buildModelCommandHandler(
  modelKey: string | null,
  onModelCommand: (modelKey: string) => void
): (() => void) | undefined {
  if (modelKey === null) return undefined
  return () => {
    onModelCommand(modelKey)
  }
}

/** Properties accepted by {@link ModelResidencyRow}. */
type ModelResidencyRowProps = {
  /** Active provider, which the meta line names. */
  readonly provider: LlmProviderTarget
  /** Whether model requests can reach the active provider, and why not. */
  readonly availability: ModelRuntimeAvailability
  /** Key of the default model, or null when none is chosen. */
  readonly defaultModel: string | null
  /** The models the backend listed. */
  readonly modelInventory: ModelInventoryState
  /** The model request in flight, if any. */
  readonly modelRequest: ModelRequestState
  /** Which weights are resident in the provider or in transition. */
  readonly modelRuntime: ModelRuntimeState
  /**
   * Requests one load, once per press of Load.
   *
   * @param modelKey - Key of the default model.
   */
  readonly onLoadModel: (modelKey: string) => void
  /**
   * Requests one unload, once per press of Unload.
   *
   * @param modelKey - Key of the loaded model.
   */
  readonly onUnloadModel: (modelKey: string) => void
}

/**
 * Presents the residency summary, a tone dot, the heading, and the meta line,
 * with Load and Unload while the inventory reports that Lys loads the models.
 *
 * @remarks Owns no state or effects. Load and Unload are absent for a
 * provider that loads its models itself, and before an inventory says who
 * loads the models. A command can be sent only while
 * the provider is connected and no model request is in flight. Load is
 * offered then only while the inventory lists the default model and it is
 * not loaded, and requests the default; Unload only while a model is loaded,
 * and requests that model. The dot is hidden from assistive technology; the
 * heading carries the state.
 * @param props - Parent-owned provider, model state, and requests.
 * @returns The card's first row.
 */
function ModelResidencyRow({
  provider,
  availability,
  defaultModel,
  modelInventory,
  modelRequest,
  modelRuntime,
  onLoadModel,
  onUnloadModel
}: ModelResidencyRowProps): ReactElement {
  const canSend = canSendModelRequest(availability, modelRequest)
  const loadModelKey = canSend
    ? findLoadableDefaultModelKey(modelInventory, defaultModel)
    : null
  const unloadModelKey = canSend ? readLoadedModelKey(modelRuntime) : null

  return (
    <div className="settings-view__card-row">
      <div className="settings-view__identity">
        <span
          aria-hidden="true"
          className="settings-view__status-dot"
          data-tone={readModelResidencyTone(modelRuntime)}
        />
        <div className="settings-view__identity-lines">
          <h2>{formatModelResidencyHeading(modelRuntime)}</h2>
          <p className="settings-view__meta">
            {formatModelResidencyMeta(
              modelRuntime,
              availability,
              defaultModel,
              provider.name
            )}
          </p>
        </div>
      </div>
      {readObservedModelLoading(modelInventory) === "lys" ? (
        <div className="settings-view__actions">
          <Button
            disabled={loadModelKey === null}
            onClick={buildModelCommandHandler(loadModelKey, onLoadModel)}
            type="button"
            variant="default"
          >
            Load
          </Button>
          <Button
            disabled={unloadModelKey === null}
            onClick={buildModelCommandHandler(unloadModelKey, onUnloadModel)}
            type="button"
            variant="outline"
          >
            Unload
          </Button>
        </div>
      ) : null}
    </div>
  )
}

/** Properties accepted by {@link ModelResidencyCard}. */
type ModelResidencyCardProps = {
  /** Active provider, which the card names. */
  readonly provider: LlmProviderTarget
  /** Whether model requests can reach the active provider, and why not. */
  readonly availability: ModelRuntimeAvailability
  /** Key of the default model, or null when none is chosen. */
  readonly defaultModel: string | null
  /** The models the backend listed. */
  readonly modelInventory: ModelInventoryState
  /** The model request in flight, if any. */
  readonly modelRequest: ModelRequestState
  /** Which weights are resident in the provider or in transition. */
  readonly modelRuntime: ModelRuntimeState
  /**
   * Requests one load, once per press of Load.
   *
   * @param modelKey - Key of the default model.
   */
  readonly onLoadModel: (modelKey: string) => void
  /**
   * Requests one unload, once per press of Unload.
   *
   * @param modelKey - Key of the loaded model.
   */
  readonly onUnloadModel: (modelKey: string) => void
  /**
   * The feedback of the latest model request: exactly one element, rendered
   * last in the card and kept mounted while the card is, so the regions it
   * announces from exist before a request updates them.
   */
  readonly children: ReactElement
}

/**
 * Presents which model weights are resident in the active provider, with
 * Load for the default model and Unload for the loaded one while the
 * inventory reports that Lys loads the models.
 *
 * @remarks The parent owns every input and the requests; the card owns no
 * state, effect, or store access. Its first row shows the residency and the
 * commands, which the parent's request feedback, rendered last, reports on.
 * The card recedes unless the provider is connected. While a load or unload
 * is in flight the card is marked busy and shows an indeterminate progress
 * bar named after the heading: the backend reports completion without
 * progress, so no value is claimed. A note says that the commands go to the
 * provider through the backend, or that the provider loads its models
 * itself, as the inventory reports, and where every model is listed.
 * @param props - Parent-owned provider, model state, requests, and request
 * feedback.
 * @returns The model card.
 */
export default function ModelResidencyCard({
  provider,
  availability,
  defaultModel,
  modelInventory,
  modelRequest,
  modelRuntime,
  onLoadModel,
  onUnloadModel,
  children
}: ModelResidencyCardProps): ReactElement {
  const isTransitioning = isModelTransitionInFlight(modelRuntime)

  return (
    <section
      aria-busy={isTransitioning}
      className="settings-view__card"
      data-dimmed={availability === "available" ? undefined : ""}
    >
      <ModelResidencyRow
        availability={availability}
        provider={provider}
        defaultModel={defaultModel}
        modelInventory={modelInventory}
        modelRequest={modelRequest}
        modelRuntime={modelRuntime}
        onLoadModel={onLoadModel}
        onUnloadModel={onUnloadModel}
      />

      {isTransitioning ? (
        /*
         * The backend acknowledges completion without percentage progress, so
         * the native bar stays indeterminate. It carries the semantics while
         * the track draws the sweep, which a native bar cannot render.
         */
        <div className="settings-view__progress">
          <progress
            aria-label={formatModelResidencyHeading(modelRuntime)}
            className="sr-only"
          />
          <span aria-hidden="true" className="settings-view__progress-fill" />
        </div>
      ) : null}

      <div className="settings-view__card-divider" />

      <p className="settings-view__card-note">
        {formatModelResidencyNote(
          readObservedModelLoading(modelInventory),
          provider
        )}
      </p>
      {children}
    </section>
  )
}
