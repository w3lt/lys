import type { ReactElement } from "react"
import type { LlmInfo } from "@lys/protocol"

import { Button } from "@/components/ui/button"
import { calculateModelRuntimeAvailability } from "@/lib/models/lm-studio-connection"
import {
  buildModelLoadConfiguration,
  findLoadConfigurationTarget
} from "@/lib/models/model-load-configuration"
import { readLoadedModelKey } from "@/lib/models/model-residency"
import { useLysStore } from "@/lib/store"
import type { LoadConfigurationSaveState } from "@/lib/store/load-configuration-settings"
import { findLoadedModelConfiguration } from "@/lib/store/model-runtime"

import ModelLoadSettingFields from "./ModelLoadSettingFields"
import {
  buildModelReloadPrompt,
  formatLoadConfigurationEmptyMessage,
  isModelResidencyChanging
} from "./model-load-presentation"
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
      return "Saving the load configuration…"
    case "failed":
      return "Could not save the load configuration. Your edits still apply to models loaded in this session."
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
 * @remarks The application store owns saves across pane unmounts; failure
 * leaves edits available and allows an explicit retry.
 */
function LoadConfigurationSaveFeedback(): ReactElement {
  const save = useLysStore((state) => state.loadConfigurationSave)
  const saveLoadConfigurationSettings = useLysStore(
    (state) => state.saveLoadConfigurationSettings
  )
  return (
    <div>
      <p
        aria-label="Load configuration save"
        aria-live="polite"
        className="settings-view__note"
        role="status"
      >
        {formatLoadConfigurationSaveStatus(save)}
      </p>
      {save.status === "failed" ? (
        <Button
          onClick={() => void saveLoadConfigurationSettings()}
          type="button"
          variant="outline"
        >
          Retry saving
        </Button>
      ) : null}
    </div>
  )
}

/** Properties accepted by {@link ModelReloadControl}. */
type ModelReloadControlProps = {
  /** Key of the loaded model a reload would address. */
  readonly modelKey: string
  /**
   * What a reload would apply, or an empty string when the stored settings
   * match the ones the model runs with.
   */
  readonly note: string
}

/**
 * Tells the person that a loaded model's stored settings changed, and offers
 * to reload it.
 *
 * @remarks Requires SettingsContext and the application store. The status
 * region stays mounted, so the note is announced when it appears. The button
 * is rendered only while there is a note. It asks the settings owner to
 * reload the model, and it is disabled while any model request is in flight
 * or the model runtime is unavailable, so a second reload cannot start before
 * the first settles.
 * @param props - Model to reload and the note to show.
 * @returns The status region and, with a note, the Reload now button.
 */
function ModelReloadControl({
  modelKey,
  note
}: ModelReloadControlProps): ReactElement {
  const backendStatus = useLysStore((state) => state.backendServerInfo.status)
  const lmStudioStatus = useLysStore((state) => state.lmStudioStatus)
  const { modelRequest, onReloadModel } = useSettingsContext()
  const availability = calculateModelRuntimeAvailability(
    backendStatus,
    lmStudioStatus
  )
  return (
    <div className="settings-view__load-reload">
      <p
        aria-label="Load configuration changes"
        aria-live="polite"
        role="status"
      >
        {note}
      </p>
      {note === "" ? null : (
        <Button
          disabled={
            availability !== "available" || modelRequest.status !== "idle"
          }
          onClick={() => void onReloadModel(modelKey)}
          size="sm"
          type="button"
          variant="outline"
        >
          Reload now
        </Button>
      )}
    </div>
  )
}

/** Properties accepted by {@link ModelLoadConfigurationEditor}. */
type ModelLoadConfigurationEditorProps = {
  /** Inventory entry of the model whose load configuration is edited. */
  readonly model: LlmInfo
}

/**
 * Connects one model's load settings to the settings and model state the
 * application owns.
 *
 * @remarks Requires SettingsContext. Each edit is a request to the settings
 * owner, which applies it in memory and saves it; the rows show the owner's
 * values. For a loaded model whose stored settings differ from the ones it
 * runs with, the changed rows and the reload control say so. That prompt is
 * withheld while the model itself is being loaded or unloaded.
 * @param props - Model to edit.
 * @returns The five setting rows and the reload control.
 */
function ModelLoadConfigurationEditor({
  model
}: ModelLoadConfigurationEditorProps): ReactElement {
  const {
    settings,
    modelRequest,
    loadedModelConfigurations,
    onAssignModelLoadSettings,
    onRemoveModelExpertCount
  } = useSettingsContext()
  const configuration = buildModelLoadConfiguration(
    settings.loadConfiguration,
    model
  )
  const reloadPrompt = isModelResidencyChanging(modelRequest, model.modelKey)
    ? null
    : buildModelReloadPrompt(
        findLoadedModelConfiguration(loadedModelConfigurations, model.modelKey),
        configuration
      )
  return (
    <>
      <ModelLoadSettingFields
        configuration={configuration}
        isAutomaticExpertCountAvailable={
          settings.loadConfiguration.default.numExperts === undefined
        }
        maxContextLength={model.maxContextLength}
        modelKey={model.modelKey}
        onAssignModelLoadSettings={onAssignModelLoadSettings}
        onRemoveModelExpertCount={onRemoveModelExpertCount}
        reloadPrompt={reloadPrompt}
      />
      <ModelReloadControl
        modelKey={model.modelKey}
        note={reloadPrompt?.note ?? ""}
      />
    </>
  )
}

/**
 * Presents the load configuration of the model the Model pane edits.
 *
 * @returns The section heading with the model's key, then that model's load
 * settings, or one line explaining why no model can be edited, and the save
 * feedback.
 * @remarks Requires SettingsContext. The edited model is the selected default
 * model when the inventory lists it, otherwise the loaded model the runtime
 * summary names. Choosing another model starts a new editor, so text being
 * typed for the previous model is discarded. Without an editable model the
 * section says to choose a default model, or that the model list is needed
 * while the inventory is not ready.
 */
export default function ModelLoadConfigurationPanel(): ReactElement {
  const { settings, modelInventory, modelRuntime } = useSettingsContext()
  const model = findLoadConfigurationTarget(
    modelInventory.status === "ready" ? modelInventory.models : [],
    settings.runtime.defaultModel,
    readLoadedModelKey(modelRuntime)
  )
  return (
    <section className="settings-view__section">
      <div className="settings-view__section-heading">
        <h2>load configuration</h2>
        {model === undefined ? null : (
          <span className="settings-view__load-target">{model.modelKey}</span>
        )}
      </div>
      {model === undefined ? (
        <p className="settings-view__note">
          {formatLoadConfigurationEmptyMessage(modelInventory.status)}
        </p>
      ) : (
        <ModelLoadConfigurationEditor key={model.modelKey} model={model} />
      )}
      <LoadConfigurationSaveFeedback />
    </section>
  )
}
