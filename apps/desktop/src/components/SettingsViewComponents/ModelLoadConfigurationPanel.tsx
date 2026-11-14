import {
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode
} from "react"
import type { LlmInfo } from "@lys/protocol"
import type { LlmProvider } from "@lys/share"

import { Button } from "@/components/ui/button"
import {
  buildDefaultModelLoadConfiguration,
  buildModelLoadConfiguration
} from "@/lib/models/model-load-configuration"
import { useLysStore } from "@/lib/store"
import type { LoadConfigurationSaveState } from "@/lib/store/load-configuration-settings"
import type { CompleteModelLoadConfiguration } from "@/lib/store/settings"

import ModelContextLengthField from "./ModelContextLengthField"
import ModelLoadSettingFields from "./ModelLoadSettingFields"
import {
  buildLoadSettingsWithBaseline,
  formatModelLoadChangeNote,
  MEASURED_CONTEXT_NOTE
} from "./model-load-presentation"
import {
  findModelTransition,
  formatContextTokens
} from "./model-pane-presentation"
import { useSettingsContext } from "./SettingsContext"

/**
 * Formats the load-configuration save outcome announced beneath the settings.
 *
 * @param save - Latest application-owned save lifecycle state.
 * @returns The saving or failure message, or an empty string while idle or
 * after a successful save, which leave nothing to announce.
 */
function formatLoadConfigurationSaveStatus(
  save: LoadConfigurationSaveState
): string {
  switch (save.status) {
    case "saving":
      return "Saving the load settings…"
    case "failed":
      return "Couldn’t save the load settings. Your edits still apply to models loaded in this session."
    case "idle":
    case "saved":
      return ""
  }
}

/**
 * Announces automatic persistence of load settings and offers recovery when
 * a write fails.
 *
 * @returns A persistent status region and a retry button only after failure.
 * @remarks The application store owns saves
 * across pane unmounts; failure leaves edits available and allows an
 * explicit retry.
 */
function LoadConfigurationSaveFeedback(): ReactElement {
  const save = useLysStore((state) => state.loadConfigurationSave)
  const saveLoadConfigurationSettings = useLysStore(
    (state) => state.saveLoadConfigurationSettings
  )
  return (
    <div className="settings-view__models-save">
      <p
        aria-label="Load settings save"
        aria-live="polite"
        className="settings-view__models-note"
        role="status"
      >
        {formatLoadConfigurationSaveStatus(save)}
      </p>
      {save.status === "failed" ? (
        <Button
          onClick={() => void saveLoadConfigurationSettings()}
          size="sm"
          type="button"
          variant="outline"
        >
          Retry saving
        </Button>
      ) : null}
    </div>
  )
}

/** Properties accepted by {@link LoadSettingsSection}. */
type LoadSettingsSectionProps = {
  /** Section title. */
  readonly title: string
  /** What the settings are and when they apply. */
  readonly caption: string
  /** The section's settings. */
  readonly children: ReactNode
}

/**
 * Presents the titled region holding the selected model's load settings.
 *
 * @remarks The title is a level-four heading
 * under the selected model's heading.
 * @param props - Title, caption, and the settings.
 * @returns The section.
 */
function LoadSettingsSection({
  title,
  caption,
  children
}: LoadSettingsSectionProps): ReactElement {
  return (
    <section className="settings-view__models-load">
      <div className="settings-view__models-load-heading">
        <h4>{title}</h4>
        <p>{caption}</p>
      </div>
      {children}
    </section>
  )
}

/** Properties accepted by {@link ModelLoadChangeActions}. */
type ModelLoadChangeActionsProps = {
  /** Whether the model is loaded, so a reload can apply the change. */
  readonly isLoaded: boolean
  /** Whether one of LM Studio's requests is in flight. */
  readonly isBusy: boolean
  /** Requests that the model be reloaded; called once per press of Reload. */
  readonly onReloadModel: () => void
  /** Requests that the change be undone; called once per press of Undo. */
  readonly onUndoChange: () => void
}

/**
 * Offers to apply a saved change by reloading the model, or to undo it.
 *
 * @remarks Reload is offered only for a loaded model and is
 * disabled while one of LM Studio's requests is in flight, since LM Studio
 * admits one at a time; Undo is always offered.
 * @param props - Model state, whether a request runs, and the two requests.
 * @returns Reload, when it applies, and Undo.
 */
function ModelLoadChangeActions({
  isLoaded,
  isBusy,
  onReloadModel,
  onUndoChange
}: ModelLoadChangeActionsProps): ReactElement {
  return (
    <>
      {isLoaded ? (
        <Button
          disabled={isBusy}
          onClick={onReloadModel}
          size="sm"
          type="button"
          variant="outline"
        >
          Reload
        </Button>
      ) : null}
      <Button onClick={onUndoChange} size="sm" type="button" variant="ghost">
        Undo
      </Button>
    </>
  )
}

/** Properties accepted by {@link ModelLoadChangeNotice}. */
type ModelLoadChangeNoticeProps = {
  /** Model whose stored settings changed. */
  readonly model: LlmInfo
  /** Settings the change is measured from and Undo restores. */
  readonly baseline: CompleteModelLoadConfiguration
  /** Settings the model would be loaded with now. */
  readonly stored: CompleteModelLoadConfiguration
}

/**
 * Tells the person that a model's stored load settings changed, and offers
 * to reload a loaded model or undo the change.
 *
 * @remarks Requires SettingsContext and the application store.
 * The status region stays mounted, so the note is announced when it
 * appears; it is empty while nothing differs from the baseline and while
 * the model itself is being loaded or unloaded. Reload asks the store to
 * reload the model with the stored settings. Undo gives the model the
 * baseline as its own settings in one change, which is saved like any edit.
 * Either one empties the region, which removes its buttons, so pressing one
 * first moves focus to the region itself, which can take focus but is not
 * in the tab order.
 * @param props - Model, baseline, and stored settings.
 * @returns The status region with its note and, with a note, its buttons.
 */
function ModelLoadChangeNotice({
  model,
  baseline,
  stored
}: ModelLoadChangeNoticeProps): ReactElement {
  const { settings } = useSettingsContext()
  const setSettings = useLysStore((state) => state.setSettings)
  const request = useLysStore((state) => state.providerModels.lmStudio.request)
  const reloadModel = useLysStore(
    (state) => state.updateLoadedModelConfiguration
  )
  const regionRef = useRef<HTMLDivElement>(null)
  const isTransitioning = findModelTransition(request, model.modelKey) !== null
  const note = isTransitioning
    ? null
    : formatModelLoadChangeNote({
        modelKey: model.modelKey,
        isLoaded: model.loaded,
        baseline,
        stored
      })

  /** Moves focus to the region, then reloads the model. */
  function handleReloadClick(): void {
    regionRef.current?.focus()
    void reloadModel({ provider: "lmStudio", modelKey: model.modelKey })
  }

  /** Moves focus to the region, then gives the model the baseline again. */
  function handleUndoClick(): void {
    regionRef.current?.focus()
    setSettings({
      ...settings,
      loadConfiguration: buildLoadSettingsWithBaseline(
        settings.loadConfiguration,
        model.modelKey,
        baseline
      )
    })
  }

  return (
    <div
      aria-label="Load settings changes"
      aria-live="polite"
      className="settings-view__models-change"
      ref={regionRef}
      role="status"
      tabIndex={-1}
    >
      {note === null ? null : (
        <>
          <span
            aria-hidden="true"
            className="settings-view__status-dot"
            data-tone="warning"
          />
          <span>{note}</span>
          <ModelLoadChangeActions
            isBusy={request.status !== "idle"}
            isLoaded={model.loaded}
            onReloadModel={handleReloadClick}
            onUndoChange={handleUndoClick}
          />
        </>
      )}
    </div>
  )
}

/** Properties accepted by {@link LmStudioLoadSettings}. */
type LmStudioLoadSettingsProps = {
  /** LM Studio model whose load settings are edited. */
  readonly model: LlmInfo
}

/**
 * Connects one LM Studio model's load settings to the settings and model
 * state the application owns.
 *
 * @remarks Requires SettingsContext and the application store.
 * Each edit is a request to the settings owner, which applies it in memory
 * and saves it; the rows show the owner's values. A change is measured from
 * the settings a loaded model runs with, as the store knows them, or for a
 * model that is not loaded from the settings it had when this editor
 * mounted, which the parent remounts for each model.
 * @param props - Model to edit.
 * @returns The load settings section with its rows, change notice, and save
 * feedback.
 */
function LmStudioLoadSettings({
  model
}: LmStudioLoadSettingsProps): ReactElement {
  const { settings, onAssignModelLoadSettings, onRemoveModelExpertCount } =
    useSettingsContext()
  const known = useLysStore((state) =>
    state.providerModels.lmStudio.loadedModelConfigurations.get(model.modelKey)
  )
  const stored = buildModelLoadConfiguration(settings.loadConfiguration, model)
  const [shownConfiguration] = useState(stored)
  const baseline =
    model.loaded && known !== undefined
      ? known.configuration
      : shownConfiguration
  return (
    <LoadSettingsSection
      caption="Saved for this model and applied each time it loads."
      title="Load settings"
    >
      <ModelLoadSettingFields
        configuration={stored}
        isAutomaticExpertCountAvailable={
          buildDefaultModelLoadConfiguration(settings.loadConfiguration)
            .numExperts === undefined
        }
        maxContextLength={model.maxContextLength}
        modelKey={model.modelKey}
        onAssignModelLoadSettings={onAssignModelLoadSettings}
        onRemoveModelExpertCount={onRemoveModelExpertCount}
      />
      <ModelLoadChangeNotice
        baseline={baseline}
        model={model}
        stored={stored}
      />
      <LoadConfigurationSaveFeedback />
    </LoadSettingsSection>
  )
}

/**
 * Shows how long Ollama keeps an idle model loaded, disabled because Lys
 * cannot set it yet.
 *
 * @remarks The native select shows Ollama's own default of
 * five minutes; its label names it and its note, which also says that Lys
 * cannot change it, describes it.
 * @returns The labelled, disabled select and its note.
 */
function IdleUnloadField(): ReactElement {
  const selectId = useId()
  const noteId = useId()
  return (
    <div className="settings-view__models-idle">
      <label htmlFor={selectId}>Unload when idle</label>
      <select
        aria-describedby={noteId}
        defaultValue="5m"
        disabled
        id={selectId}
      >
        <option value="5m">After 5 minutes</option>
        <option value="30m">After 30 minutes</option>
        <option value="1h">After 1 hour</option>
        <option value="never">Never</option>
      </select>
      <p className="settings-view__models-note" id={noteId}>
        Frees this machine’s memory. An unloaded model can’t answer until you
        load it again. Lys can’t change it yet, so Ollama’s own setting applies.
      </p>
    </div>
  )
}

/** Properties accepted by {@link ProviderLoadSettings}. */
type ProviderLoadSettingsProps = {
  /** Ollama or Ollama Cloud, which apply their own load settings. */
  readonly provider: "ollama" | "ollamaCloud"
  /** Model whose load settings are shown. */
  readonly model: LlmInfo
}

/**
 * Shows the load settings of a model whose provider applies its own, with
 * the controls disabled because Lys cannot set them yet.
 *
 * @remarks The context length is the one the model is
 * loaded with, else its maximum. For Ollama, the idle unload delay shows
 * Ollama's own default of five minutes. The caption says why nothing can be
 * changed.
 * @param props - Provider and model.
 * @returns The load settings section with disabled controls.
 */
function ProviderLoadSettings({
  provider,
  model
}: ProviderLoadSettingsProps): ReactElement {
  const providerName = provider === "ollama" ? "Ollama" : "Ollama Cloud"
  return (
    <LoadSettingsSection
      caption={`${providerName} applies its own load settings. Lys can’t change them yet.`}
      title="Load settings"
    >
      <ModelContextLengthField
        contextLength={model.loadedContextLength ?? model.maxContextLength}
        maxContextLength={model.maxContextLength}
        note={`${providerName} sets this length. ${MEASURED_CONTEXT_NOTE}`}
        onContextLengthChange={null}
      />
      {provider === "ollama" ? <IdleUnloadField /> : null}
    </LoadSettingsSection>
  )
}

/** Properties accepted by {@link ModelLoadConfigurationPanel}. */
export type ModelLoadConfigurationPanelProps = {
  /** Provider of the selected model. */
  readonly provider: LlmProvider
  /** The selected model. */
  readonly model: LlmInfo
}

/**
 * Presents the load settings of the Models pane's selected model, as its
 * provider lets them be set.
 *
 * @remarks LM Studio's models have editable settings
 * that Lys saves and sends with each load; Ollama and Ollama Cloud apply
 * their own, which are shown disabled; Groq sets the context of its models,
 * which is shown as a fact. The parent remounts it for each model, so text
 * being typed for the previous model is discarded.
 * @param props - Provider and model.
 * @returns The provider's load settings section.
 */
export default function ModelLoadConfigurationPanel({
  provider,
  model
}: ModelLoadConfigurationPanelProps): ReactElement {
  switch (provider) {
    case "lmStudio":
      return <LmStudioLoadSettings model={model} />
    case "ollama":
    case "ollamaCloud":
      return <ProviderLoadSettings model={model} provider={provider} />
    case "groq":
      return (
        <LoadSettingsSection
          caption={`Set by Groq for this model. ${MEASURED_CONTEXT_NOTE}`}
          title="Context"
        >
          <div className="settings-view__models-fixed">
            <span>Context length</span>
            <span className="settings-view__models-mono">
              {formatContextTokens(model.maxContextLength)}
            </span>
          </div>
        </LoadSettingsSection>
      )
  }
}
