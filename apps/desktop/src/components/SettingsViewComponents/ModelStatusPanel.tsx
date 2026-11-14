import { useId, useState, type ReactElement } from "react"
import type { LlmInfo } from "@lys/protocol"
import type { LlmProvider } from "@lys/share"
import { Activity } from "lucide-react"

import { Button } from "@/components/ui/button"

import {
  describeCloudModelStatus,
  describeLocalModelStatus,
  findModelTransition,
  isModelCheckFailed,
  type ModelCheckObservation,
  type ModelStatusDescription
} from "./model-pane-presentation"

/** What the selected model's provider has observed, without the check request. */
export type ModelProviderObservation = Omit<
  ModelCheckObservation,
  "isCheckRequested"
>

/** Properties accepted by {@link ModelStatusPanel}. */
export type ModelStatusPanelProps = {
  /** Provider of the model. */
  readonly provider: LlmProvider
  /** The selected model. */
  readonly model: LlmInfo
  /** Whether the model is the session's default. */
  readonly isDefault: boolean
  /** The provider's request, health, failure, and settlement time. */
  readonly observation: ModelProviderObservation
  /** Whether Lys loads and unloads the provider's models. */
  readonly canLoadModels: boolean
  /** Requests that the model be loaded; called once per press of Load. */
  readonly onLoadModel: () => void
  /** Requests that the model be unloaded; called once per press of Unload. */
  readonly onUnloadModel: () => void
  /**
   * Requests that the provider be asked about the model without generating
   * a reply; called once per press of Check status or Try again.
   */
  readonly onCheckModel: () => void
}

/** Properties accepted by {@link LocalModelAction}. */
type LocalModelActionProps = Pick<
  ModelStatusPanelProps,
  "isDefault" | "canLoadModels" | "onLoadModel" | "onUnloadModel"
> & {
  /** Whether the model is loaded. */
  readonly isLoaded: boolean
  /** Whether a request of the provider is in flight. */
  readonly isBusy: boolean
  /** Identifier of the note that explains the state. */
  readonly noteId: string
}

/**
 * Offers Load for a model on disk and Unload for a loaded model.
 *
 * @remarks Both are disabled while a request is in flight,
 * the model's own load or unload included, and while Lys cannot load the
 * provider's models; Unload also for the session's default. The one button
 * stays mounted through a load or unload and changes its word when it
 * ends, so focus stays on it. Each is described by the status note, which
 * says why.
 * @param props - Model state, the note's identifier, and the two requests.
 * @returns The button that applies.
 */
function LocalModelAction({
  isLoaded,
  isDefault,
  canLoadModels,
  isBusy,
  noteId,
  onLoadModel,
  onUnloadModel
}: LocalModelActionProps): ReactElement {
  const isDisabled = isBusy || !canLoadModels
  return (
    <Button
      aria-describedby={noteId}
      disabled={isLoaded ? isDisabled || isDefault : isDisabled}
      onClick={isLoaded ? onUnloadModel : onLoadModel}
      size="sm"
      type="button"
      variant="outline"
    >
      {isLoaded ? "Unload" : "Load"}
    </Button>
  )
}

/** Properties accepted by {@link ModelCheckAction}. */
type ModelCheckActionProps = {
  /** Whether the last check the person asked for failed. */
  readonly isFailed: boolean
  /** Whether a request of the provider is in flight. */
  readonly isBusy: boolean
  /** Asks the provider about the model. */
  readonly onCheckModel: () => void
}

/**
 * Offers to ask a cloud provider about the model.
 *
 * @remarks Reads Try again after a failed check and Check
 * status otherwise; disabled while a request is in flight.
 * @param props - Whether the check failed or a request runs, and the
 * request.
 * @returns The check button.
 */
function ModelCheckAction({
  isFailed,
  isBusy,
  onCheckModel
}: ModelCheckActionProps): ReactElement {
  return (
    <Button
      disabled={isBusy}
      onClick={onCheckModel}
      size="sm"
      type="button"
      variant={isFailed ? "destructive" : "outline"}
    >
      {isFailed ? null : <Activity aria-hidden="true" />}
      {isFailed ? "Try again" : "Check status"}
    </Button>
  )
}

/**
 * Describes the selected model's status for its provider.
 *
 * @param props - The panel's properties.
 * @param isCheckRequested - Whether a check of the model was asked for.
 * @returns The local status for LM Studio and Ollama, the checked status
 * for Ollama Cloud and Groq.
 */
function describeModelStatus(
  props: ModelStatusPanelProps,
  isCheckRequested: boolean
): ModelStatusDescription {
  const { provider, model, observation } = props
  switch (provider) {
    case "lmStudio":
    case "ollama":
      return describeLocalModelStatus(
        provider,
        model,
        observation.request,
        props.isDefault
      )
    case "ollamaCloud":
    case "groq":
      return describeCloudModelStatus(provider, model.modelKey, {
        ...observation,
        isCheckRequested
      })
  }
}

/** Properties accepted by {@link ModelStatusLines}. */
type ModelStatusLinesProps = {
  /** The status to show. */
  readonly status: ModelStatusDescription
  /** Identifier given to the note, so the action can be described by it. */
  readonly noteId: string
}

/**
 * Shows the selected model's state beside a toned dot, and the note on it.
 *
 * @remarks The state is a word beside the dot, so it does
 * not rely on colour; the note is a status region, so changes are
 * announced.
 * @param props - The status and the note's identifier.
 * @returns The state line and the note.
 */
function ModelStatusLines({
  status,
  noteId
}: ModelStatusLinesProps): ReactElement {
  return (
    <div className="settings-view__models-status-lines">
      <p className="settings-view__models-status-word">
        <span
          aria-hidden="true"
          className="settings-view__status-dot"
          data-tone={status.tone}
        />
        <span>{status.word}</span>
        <span>{status.place}</span>
      </p>
      <p className="settings-view__models-note" id={noteId} role="status">
        {status.note}
      </p>
    </div>
  )
}

/** Properties accepted by {@link ModelLoadProgress}. */
type ModelLoadProgressProps = {
  /** Key of the model being loaded. */
  readonly modelKey: string
}

/**
 * Shows that a model is being loaded, without claiming how far the load is.
 *
 * @remarks Nothing reports how far a load is, so the native
 * bar stays indeterminate and carries the semantics, named after the model,
 * while the track draws the sweep, which a native bar cannot render.
 * @param props - The model being loaded.
 * @returns The indeterminate progress bar.
 */
function ModelLoadProgress({ modelKey }: ModelLoadProgressProps): ReactElement {
  return (
    <div className="settings-view__progress settings-view__models-progress">
      <progress aria-label={`Loading ${modelKey}`} className="sr-only" />
      <span aria-hidden="true" className="settings-view__progress-fill" />
    </div>
  )
}

/**
 * Shows whether the selected model can answer, and offers the action that
 * changes or confirms it.
 *
 * @remarks Owns whether the person asked to check this
 * model, so only that check's failure reads Couldn't check; the parent
 * remounts it for another model. A model on this machine offers Load or
 * Unload, kept in place and disabled while it loads or unloads, and shows
 * an indeterminate progress bar while it loads. A cloud model offers Check
 * status, or Try again after a failed check.
 * @param props - Provider, model, observations, and the three requests.
 * @returns The status box.
 */
export default function ModelStatusPanel(
  props: ModelStatusPanelProps
): ReactElement {
  const { provider, model, observation } = props
  const noteId = useId()
  const [isCheckRequested, setIsCheckRequested] = useState(false)
  const isBusy = observation.request.status !== "idle"
  const isLocal = provider === "lmStudio" || provider === "ollama"
  const transition = findModelTransition(observation.request, model.modelKey)

  /** Remembers that the person asked to check this model, then asks. */
  function handleCheckModel(): void {
    setIsCheckRequested(true)
    props.onCheckModel()
  }

  return (
    <div className="settings-view__models-status">
      <ModelStatusLines
        noteId={noteId}
        status={describeModelStatus(props, isCheckRequested)}
      />
      {isLocal ? (
        <LocalModelAction
          canLoadModels={props.canLoadModels}
          isBusy={isBusy}
          isDefault={props.isDefault}
          isLoaded={model.loaded}
          noteId={noteId}
          onLoadModel={props.onLoadModel}
          onUnloadModel={props.onUnloadModel}
        />
      ) : (
        <ModelCheckAction
          isBusy={isBusy}
          isFailed={isModelCheckFailed(
            { ...observation, isCheckRequested },
            model.modelKey
          )}
          onCheckModel={handleCheckModel}
        />
      )}
      {transition === "loading" ? (
        <ModelLoadProgress modelKey={model.modelKey} />
      ) : null}
    </div>
  )
}
