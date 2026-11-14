import {
  buildLoadConfigurationSettings,
  isModelLoadConfigurationEqual
} from "@/lib/models/model-load-configuration"
import type {
  CompleteModelLoadConfiguration,
  LoadConfigurationSettings
} from "@/lib/store/settings"

/** Largest evaluation batch size the Models pane accepts, in tokens. */
export const MAXIMUM_EVAL_BATCH_SIZE = 8192

/**
 * Sentence under a model's context length naming what is measured against
 * it, for every provider whose context length the Models pane shows.
 */
export const MEASURED_CONTEXT_NOTE =
  "The composer’s context meter and the Agents pane measure against this length."

/** A change to one model's stored load settings, as the Models pane shows it. */
export type ModelLoadChange = {
  /** Key of the model. */
  readonly modelKey: string
  /** Whether the model is loaded. */
  readonly isLoaded: boolean
  /**
   * Settings the change is measured from: the ones a loaded model runs with,
   * or the ones a model not loaded had when it was shown.
   */
  readonly baseline: CompleteModelLoadConfiguration
  /** Settings the model would be loaded with now. */
  readonly stored: CompleteModelLoadConfiguration
}

/**
 * Formats the note shown after a model's stored load settings changed.
 *
 * @param change - The model, whether it is loaded, and the settings compared.
 * @returns Null when nothing differs; else that the change is saved, and
 * that a loaded model applies it once reloaded and a model not loaded when
 * it is loaded.
 */
export function formatModelLoadChangeNote(
  change: ModelLoadChange
): string | null {
  if (isModelLoadConfigurationEqual(change.baseline, change.stored)) return null
  return change.isLoaded
    ? `Saved. Reload ${change.modelKey} to apply it.`
    : "Saved. Applies when you load it."
}

/**
 * Builds the load settings in which one model's settings are a baseline
 * again.
 *
 * @param settings - Stored load settings; not modified.
 * @param modelKey - Key of the model whose change is undone.
 * @param baseline - Settings the model is given back.
 * @returns Newly owned settings in which the model has the baseline as its
 * own settings, without an expert count of its own when the baseline has
 * none.
 */
export function buildLoadSettingsWithBaseline(
  settings: LoadConfigurationSettings,
  modelKey: string,
  baseline: CompleteModelLoadConfiguration
): LoadConfigurationSettings {
  const { numExperts, ...assigned } = baseline
  const restored = buildLoadConfigurationSettings(settings, {
    kind: "assignment",
    modelKey,
    settings: numExperts === undefined ? assigned : baseline
  })
  return numExperts === undefined
    ? buildLoadConfigurationSettings(restored, {
        kind: "expert-count-removal",
        modelKey
      })
    : restored
}

/**
 * Parses the text typed into the evaluation batch size box.
 *
 * @param text - Text the box holds.
 * @returns The batch size when the text is a whole number from 1 to
 * {@link MAXIMUM_EVAL_BATCH_SIZE}, otherwise null.
 */
export function parseEvalBatchSize(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null
  const size = Number(text.trim())
  return size >= 1 && size <= MAXIMUM_EVAL_BATCH_SIZE ? size : null
}
