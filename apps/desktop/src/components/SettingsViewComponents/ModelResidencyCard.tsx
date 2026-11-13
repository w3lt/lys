import type { LlmModelReference } from "@lys/share"
import type { ReactElement } from "react"
import { Button } from "@/components/ui/button"
import type { LlmProviderTarget } from "@/lib/models/llm-provider-target"
import type { ModelAvailability } from "@/lib/models/model-availability"
import {
  formatModelResidencyHeading,
  formatModelResidencyMeta,
  readModelResidencyTone
} from "@/lib/models/model-residency"
import type { ProviderAvailability } from "@/lib/models/provider-connection"
import {
  readObservedModelLoading,
  type ModelInventoryState,
  type ModelRequestState,
  type ObservedModelLoading
} from "@/lib/store/model-runtime"

/** The command the card offers for its model, and the key it applies to. */
type ModelResidencyCommand = {
  /** Key of the model to load, or null when Load cannot be sent. */
  readonly loadModelKey: string | null
  /** Key of the model to unload, or null when Unload cannot be sent. */
  readonly unloadModelKey: string | null
}

/**
 * Finds which command the card can send for its model now.
 *
 * @param provider - Provider the card shows, whose requests the commands
 * become.
 * @param model - Model the card shows, or null when there is none.
 * @param availability - Availability of that model, or null when there is
 * none.
 * @param modelRequest - The provider's request in flight, if any.
 * @returns Load for a model of that provider the inventory lists and that is
 * not loaded, Unload for one that is loaded, and neither while a request of
 * the provider is in flight; requests are sent one at a time per provider.
 */
function findModelResidencyCommand(
  provider: LlmProviderTarget,
  model: LlmModelReference | null,
  availability: ModelAvailability | null,
  modelRequest: ModelRequestState
): ModelResidencyCommand {
  if (
    model === null ||
    model.provider !== provider.provider ||
    modelRequest.status !== "idle"
  ) {
    return { loadModelKey: null, unloadModelKey: null }
  }
  return {
    loadModelKey: availability?.status === "not-loaded" ? model.modelKey : null,
    unloadModelKey: availability?.status === "loaded" ? model.modelKey : null
  }
}

/**
 * Formats the card's note.
 *
 * @param modelLoading - Who loads the models, as the inventory reports.
 * @param provider - Provider the card shows, which the note names.
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
      return `Loading and unloading use ${provider.name} through the backend. This summary shows the model a new conversation uses; manage every loaded model in Model settings.`
    case "provider":
      return `${provider.name} decides which models are in memory, so Lys does not load or unload them. This summary shows the model a new conversation uses; see every model in Model settings.`
    case "unknown":
      return "This summary shows the model a new conversation uses; see every model in Model settings."
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
  /** Provider the card shows, whose requests the commands become. */
  readonly provider: LlmProviderTarget
  /**
   * Model a new conversation uses: the default, or without one the first
   * model that can answer; null when there is neither.
   */
  readonly model: LlmModelReference | null
  /** Availability of that model, or null when there is none. */
  readonly availability: ModelAvailability | null
  /** Who loads the provider's models, as its inventory reports. */
  readonly modelLoading: ObservedModelLoading
  /** The provider's request in flight, if any. */
  readonly modelRequest: ModelRequestState
  /**
   * Requests one load, once per press of Load.
   *
   * @param modelKey - Key of the shown model.
   */
  readonly onLoadModel: (modelKey: string) => void
  /**
   * Requests one unload, once per press of Unload.
   *
   * @param modelKey - Key of the shown model.
   */
  readonly onUnloadModel: (modelKey: string) => void
}

/**
 * Presents the residency summary, a tone dot, the heading, and the meta line,
 * with Load and Unload while the inventory reports that Lys loads the models.
 *
 * @remarks Owns no state or effects. Load and Unload are absent for a
 * provider that loads its models itself, and before an inventory says who
 * loads the models. A command applies only to the shown model, only while it
 * belongs to the shown provider and no request of that provider is in
 * flight: Load while the inventory lists the model and it is not loaded,
 * Unload while it is loaded. The dot is hidden from assistive technology;
 * the heading carries the state.
 * @param props - Parent-owned provider, model state, and requests.
 * @returns The card's first row.
 */
function ModelResidencyRow({
  provider,
  model,
  availability,
  modelLoading,
  modelRequest,
  onLoadModel,
  onUnloadModel
}: ModelResidencyRowProps): ReactElement {
  const { loadModelKey, unloadModelKey } = findModelResidencyCommand(
    provider,
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
          <p className="settings-view__meta">
            {formatModelResidencyMeta(model, availability)}
          </p>
        </div>
      </div>
      {modelLoading === "lys" ? (
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
  /** Provider the card shows, which the note names. */
  readonly provider: LlmProviderTarget
  /** Whether model requests can reach that provider, and why not. */
  readonly providerAvailability: ProviderAvailability
  /**
   * Model a new conversation uses: the default, or without one the first
   * model that can answer; null when there is neither.
   */
  readonly model: LlmModelReference | null
  /** Availability of that model, or null when there is none. */
  readonly availability: ModelAvailability | null
  /** The models the provider's inventory lists. */
  readonly modelInventory: ModelInventoryState
  /** The provider's request in flight, if any. */
  readonly modelRequest: ModelRequestState
  /**
   * Requests one load, once per press of Load.
   *
   * @param modelKey - Key of the shown model.
   */
  readonly onLoadModel: (modelKey: string) => void
  /**
   * Requests one unload, once per press of Unload.
   *
   * @param modelKey - Key of the shown model.
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
 * Presents whether the model a new conversation uses is in memory, with Load
 * and Unload for it while its provider's inventory reports that Lys loads
 * the models.
 *
 * @remarks The parent owns every input and the requests; the card owns no
 * state, effect, or store access. Its first row shows the residency and the
 * commands, which the parent's request feedback, rendered last, reports on.
 * The card recedes unless the provider is connected. While the model loads
 * or unloads the card is marked busy and shows an indeterminate progress
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
  providerAvailability,
  model,
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
      data-dimmed={providerAvailability === "available" ? undefined : ""}
    >
      <ModelResidencyRow
        availability={availability}
        model={model}
        modelLoading={modelLoading}
        modelRequest={modelRequest}
        onLoadModel={onLoadModel}
        onUnloadModel={onUnloadModel}
        provider={provider}
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
        {formatModelResidencyNote(modelLoading, provider)}
      </p>
      {children}
    </section>
  )
}
