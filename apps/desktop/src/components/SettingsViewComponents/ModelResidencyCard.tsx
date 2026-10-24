import type { ReactElement } from "react"
import { Button } from "@/components/ui/button"
import type { ModelRuntimeAvailability } from "@/lib/models/lm-studio-connection"
import {
  findLoadedModel,
  formatModelResidencyHeading,
  formatModelResidencyMeta,
  readModelResidencyAction,
  readModelResidencyTone
} from "@/lib/models/model-residency"
import {
  isModelTransitionInFlight,
  type ModelInventoryState,
  type ModelRequestState,
  type ModelRuntimeState
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
 * Finds the loaded model when Lys can unload it.
 *
 * @param modelRuntime - Which weights are resident in LM Studio or in
 * transition.
 * @param modelInventory - The models the backend listed.
 * @returns The key of the model the summary names as loaded while the
 * inventory lists an instance of it that Lys loaded, or null: no model
 * loaded, or one only another program loaded.
 */
function findUnloadableModelKey(
  modelRuntime: ModelRuntimeState,
  modelInventory: ModelInventoryState
): string | null {
  const loadedModel = findLoadedModel(modelRuntime, modelInventory)
  if (loadedModel === undefined) return null
  return readModelResidencyAction(loadedModel) === "unload"
    ? loadedModel.modelKey
    : null
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
  /** Whether model requests can reach LM Studio, and why not. */
  readonly availability: ModelRuntimeAvailability
  /** Key of the default model, or null when none is chosen. */
  readonly defaultModel: string | null
  /** The models the backend listed. */
  readonly modelInventory: ModelInventoryState
  /** The model request in flight, if any. */
  readonly modelRequest: ModelRequestState
  /** Which weights are resident in LM Studio or in transition. */
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
 * with Load and Unload.
 *
 * @remarks Owns no state or effects. A command can be sent only while LM
 * Studio is connected and no model request is in flight. Load is offered
 * then only while the inventory lists the default model and it is not
 * loaded, and requests the default; Unload only while a model is loaded and
 * the inventory lists an instance of it that Lys loaded, and requests that
 * model. The dot is hidden from assistive technology; the heading carries the
 * state.
 * @param props - Parent-owned model state and requests.
 * @returns The card's first row.
 */
function ModelResidencyRow({
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
  const unloadModelKey = canSend
    ? findUnloadableModelKey(modelRuntime, modelInventory)
    : null

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
            {formatModelResidencyMeta(modelRuntime, availability, defaultModel)}
          </p>
        </div>
      </div>
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
    </div>
  )
}

/** Properties accepted by {@link ModelResidencyCard}. */
type ModelResidencyCardProps = {
  /** Whether model requests can reach LM Studio, and why not. */
  readonly availability: ModelRuntimeAvailability
  /** Key of the default model, or null when none is chosen. */
  readonly defaultModel: string | null
  /** The models the backend listed. */
  readonly modelInventory: ModelInventoryState
  /** The model request in flight, if any. */
  readonly modelRequest: ModelRequestState
  /** Which weights are resident in LM Studio or in transition. */
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
 * Presents which model weights are resident in LM Studio, with Load for the
 * default model and Unload for the loaded one when Lys loaded it.
 *
 * @remarks The parent owns every input and the requests; the card owns no
 * state, effect, or store access. Its first row shows the residency and the
 * commands, which the parent's request feedback, rendered last, reports on.
 * The card recedes unless LM Studio is connected. While a load or unload is
 * in flight the card is marked busy and shows an indeterminate progress bar
 * named after the heading: the backend reports completion without progress,
 * so no value is claimed. A note says that the commands go to LM Studio
 * through the backend, that Lys unloads only the models it loaded, and where
 * every loaded model is managed.
 * @param props - Parent-owned model state, requests, and request feedback.
 * @returns The model card.
 */
export default function ModelResidencyCard({
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
        Loading and unloading use LM Studio through the backend, and Lys unloads
        only the models it loaded. This summary prefers the loaded default;
        manage every loaded model in Model settings.
      </p>
      {children}
    </section>
  )
}
