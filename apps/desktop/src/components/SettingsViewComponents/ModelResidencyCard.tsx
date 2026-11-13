import { LLM_PROVIDER_NAMES, type LlmModelReference } from "@lys/share"
import type { ReactElement } from "react"
import { Button } from "@/components/ui/button"
import type { ModelAvailability } from "@/lib/models/model-availability"
import { formatModelReferenceLabel } from "@/lib/models/provider-connection"
import {
  formatModelResidencyHeading,
  formatModelResidencyMeta,
  readModelResidencyTone
} from "@/lib/models/model-residency"
import {
  readObservedModelLoading,
  type ModelInventoryState,
  type ModelRequestState,
  type ObservedModelLoading
} from "@/lib/store/model-runtime"

/** The command the card offers for its model, and the model it applies to. */
type ModelResidencyCommand = {
  /** Model to load, or null when Load cannot be sent. */
  readonly loadModel: LlmModelReference | null
  /** Model to unload, or null when Unload cannot be sent. */
  readonly unloadModel: LlmModelReference | null
}

/**
 * Finds which command the card can send for its model now.
 *
 * @param model - Model the card shows, or null when there is none.
 * @param availability - Availability of that model, or null when there is
 * none.
 * @param modelRequest - The request in flight of that model's provider, if
 * any.
 * @returns Load for a model its provider lists and that is not loaded,
 * Unload for one that is loaded, and neither while a request of the provider
 * is in flight; requests are sent one at a time per provider.
 */
function findModelResidencyCommand(
  model: LlmModelReference | null,
  availability: ModelAvailability | null,
  modelRequest: ModelRequestState
): ModelResidencyCommand {
  if (model === null || modelRequest.status !== "idle") {
    return { loadModel: null, unloadModel: null }
  }
  return {
    loadModel: availability?.status === "not-loaded" ? model : null,
    unloadModel: availability?.status === "loaded" ? model : null
  }
}

/**
 * Formats the card's note.
 *
 * @param modelLoading - Who loads the models, as the inventory of the
 * model's provider reports.
 * @param model - Model a new conversation uses, whose provider the note
 * names, or null when there is none.
 * @returns That Load and Unload go to the provider through the backend, or
 * that the provider loads its models itself, then where every model is
 * listed; only where every model is listed while no inventory has been read
 * or there is no model.
 */
function formatModelResidencyNote(
  modelLoading: ObservedModelLoading,
  model: LlmModelReference | null
): string {
  if (model === null || modelLoading === "unknown")
    return "This summary shows the model a new conversation uses; see every model in Model settings."
  const providerName = LLM_PROVIDER_NAMES[model.provider]
  return modelLoading === "lys"
    ? `Loading and unloading use ${providerName} through the backend. This summary shows the model a new conversation uses; manage every loaded model in Model settings.`
    : `${providerName} decides which models are in memory, so Lys does not load or unload them. This summary shows the model a new conversation uses; see every model in Model settings.`
}

/**
 * Builds the click handler of one model command.
 *
 * @param model - Model the command applies to, or null when the command
 * cannot be sent.
 * @param onModelCommand - Requests the command for one model.
 * @returns A handler that requests the command for `model` once per click,
 * or undefined without a model, whose button is disabled.
 */
function buildModelCommandHandler(
  model: LlmModelReference | null,
  onModelCommand: (model: LlmModelReference) => void
): (() => void) | undefined {
  if (model === null) return undefined
  return () => {
    onModelCommand(model)
  }
}

/** Properties accepted by {@link ModelResidencyRow}. */
type ModelResidencyRowProps = {
  /**
   * Model a new conversation uses: the session's default, or without one the
   * first model that can answer; null when there is neither.
   */
  readonly model: LlmModelReference | null
  /** Availability of that model, or null when there is none. */
  readonly availability: ModelAvailability | null
  /** Who loads the models of its provider, as that inventory reports. */
  readonly modelLoading: ObservedModelLoading
  /** The request in flight of that model's provider, if any. */
  readonly modelRequest: ModelRequestState
  /**
   * Requests one load, once per press of Load.
   *
   * @param model - The shown model.
   */
  readonly onLoadModel: (model: LlmModelReference) => void
  /**
   * Requests one unload, once per press of Unload.
   *
   * @param model - The shown model.
   */
  readonly onUnloadModel: (model: LlmModelReference) => void
}

/**
 * Presents the residency summary, a tone dot, the heading, the model's name
 * with its provider, and the meta line, with Load and Unload while the
 * inventory reports that Lys loads the models.
 *
 * @remarks Owns no state or effects. Load and Unload are absent for a
 * provider that loads its models itself, and before an inventory says who
 * loads the models. A command applies only to the shown model, only while no
 * request of its provider is in flight: Load while the inventory lists the
 * model and it is not loaded, Unload while it is loaded. The dot is hidden
 * from assistive technology; the heading carries the state.
 * @param props - Parent-owned model state and requests.
 * @returns The card's first row.
 */
function ModelResidencyRow({
  model,
  availability,
  modelLoading,
  modelRequest,
  onLoadModel,
  onUnloadModel
}: ModelResidencyRowProps): ReactElement {
  const { loadModel, unloadModel } = findModelResidencyCommand(
    model,
    availability,
    modelRequest
  )

  return (
    <div className="settings-view__card-row">
      <div className="settings-view__identity">
        <span
          aria-hidden="true"
          className="settings-view__status-dot"
          data-tone={readModelResidencyTone(availability)}
        />
        <div className="settings-view__identity-lines">
          <h2>{formatModelResidencyHeading(availability)}</h2>
          {model === null ? null : <p>{formatModelReferenceLabel(model)}</p>}
          <p className="settings-view__meta">
            {formatModelResidencyMeta(model, availability)}
          </p>
        </div>
      </div>
      {modelLoading === "lys" ? (
        <div className="settings-view__actions">
          <Button
            disabled={loadModel === null}
            onClick={buildModelCommandHandler(loadModel, onLoadModel)}
            type="button"
            variant="default"
          >
            Load
          </Button>
          <Button
            disabled={unloadModel === null}
            onClick={buildModelCommandHandler(unloadModel, onUnloadModel)}
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
  /**
   * Model a new conversation uses: the session's default, or without one the
   * first model that can answer; null when there is neither.
   */
  readonly model: LlmModelReference | null
  /** Availability of that model, or null when there is none. */
  readonly availability: ModelAvailability | null
  /** Whether model requests can reach that model's provider. */
  readonly isProviderAvailable: boolean
  /** The models the inventory of that model's provider lists. */
  readonly modelInventory: ModelInventoryState
  /** The request in flight of that model's provider, if any. */
  readonly modelRequest: ModelRequestState
  /**
   * Requests one load, once per press of Load.
   *
   * @param model - The shown model.
   */
  readonly onLoadModel: (model: LlmModelReference) => void
  /**
   * Requests one unload, once per press of Unload.
   *
   * @param model - The shown model.
   */
  readonly onUnloadModel: (model: LlmModelReference) => void
  /**
   * The feedback of the latest model request: exactly one element, rendered
   * last in the card and kept mounted while the card is, so the regions it
   * announces from exist before a request updates them.
   */
  readonly children: ReactElement
}

/**
 * Presents whether the model a new conversation uses is in memory, named with
 * its provider, with Load and Unload for it while its provider's inventory
 * reports that Lys loads the models.
 *
 * @remarks The parent owns every input and the requests; the card owns no
 * state, effect, or store access. Its first row shows the residency and the
 * commands, which the parent's request feedback, rendered last, reports on.
 * The card recedes unless the model's provider is connected. While
 * the model loads or unloads the card is marked busy and shows an
 * indeterminate progress bar named after the heading: the backend reports
 * completion without progress, so no value is claimed. A note says that the commands go to the
 * provider through the backend, or that the provider loads its models
 * itself, as the inventory reports, and where every model is listed.
 * @param props - Parent-owned model state, requests, and request feedback.
 * @returns The model card.
 */
export default function ModelResidencyCard({
  model,
  isProviderAvailable,
  availability,
  modelInventory,
  modelRequest,
  onLoadModel,
  onUnloadModel,
  children
}: ModelResidencyCardProps): ReactElement {
  const isTransitioning =
    availability?.status === "loading" || availability?.status === "unloading"
  const modelLoading = readObservedModelLoading(modelInventory)

  return (
    <section
      aria-busy={isTransitioning}
      className="settings-view__card"
      data-dimmed={isProviderAvailable ? undefined : ""}
    >
      <ModelResidencyRow
        availability={availability}
        model={model}
        modelLoading={modelLoading}
        modelRequest={modelRequest}
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
            aria-label={formatModelResidencyHeading(availability)}
            className="sr-only"
          />
          <span aria-hidden="true" className="settings-view__progress-fill" />
        </div>
      ) : null}

      <div className="settings-view__card-divider" />

      <p className="settings-view__card-note">
        {formatModelResidencyNote(modelLoading, model)}
      </p>
      {children}
    </section>
  )
}
