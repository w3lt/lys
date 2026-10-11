import {
  formatModelReloadNote,
  listModelLoadDifferences,
  type ModelLoadDifference,
  type ModelLoadSettingName
} from "@/lib/models/model-load-configuration"
import type {
  LoadedModelConfiguration,
  ModelInventoryState,
  ModelRequestState
} from "@/lib/store/model-runtime"
import type { CompleteModelLoadConfiguration } from "@/lib/store/settings"

/** What the Model pane says about a loaded model whose stored settings changed. */
export type ModelReloadPrompt = {
  /** Line shown under the settings. */
  readonly note: string
  /**
   * Settings whose loaded value is known and differs from the stored one;
   * empty when the loaded settings are only assumed.
   */
  readonly differences: readonly ModelLoadDifference[]
}

/**
 * Answers whether a request is loading or unloading one model.
 *
 * @param modelRequest - Current model request.
 * @param modelKey - Key of the model.
 * @returns True while a load or unload of that model is in flight.
 */
export function isModelResidencyChanging(
  modelRequest: ModelRequestState,
  modelKey: string
): boolean {
  if (
    modelRequest.status !== "loading" &&
    modelRequest.status !== "unloading"
  ) {
    return false
  }
  return modelRequest.modelKey === modelKey
}

/**
 * Builds what the pane says when a loaded model's stored settings differ from
 * the ones it runs with.
 *
 * @param known - What is known about the loaded model's configuration, or
 * undefined when nothing is.
 * @param stored - Configuration the model would be loaded with now.
 * @returns Null when nothing is known or nothing differs. For a configuration
 * Lys sent, the differences and a note listing them. For an assumed
 * configuration, a note that changes apply on the next load and no
 * differences, because the loaded values are not known.
 */
export function buildModelReloadPrompt(
  known: LoadedModelConfiguration | undefined,
  stored: CompleteModelLoadConfiguration
): ModelReloadPrompt | null {
  if (known === undefined) return null
  const differences = listModelLoadDifferences(known.configuration, stored)
  if (differences.length === 0) return null
  switch (known.origin) {
    case "sent":
      return { note: formatModelReloadNote(differences), differences }
    case "assumed":
      return {
        note: "Changes apply the next time this model loads.",
        differences: []
      }
  }
}

/**
 * Finds the value a setting was loaded with when it differs from the stored one.
 *
 * @param reloadPrompt - Current reload prompt, or null for none.
 * @param setting - Setting whose row asks.
 * @returns The loaded value as its row shows it, or null when the setting
 * does not differ or its loaded value is not known.
 */
export function findLoadedSettingValue(
  reloadPrompt: ModelReloadPrompt | null,
  setting: ModelLoadSettingName
): string | null {
  const difference = reloadPrompt?.differences.find(
    (candidate) => candidate.setting === setting
  )
  return difference?.loadedValue ?? null
}

/**
 * Formats the note shown under the context length row.
 *
 * @param modelKey - Key of the model being edited.
 * @param maximumText - Abbreviated maximum context length, or null when the
 * runtime reports no usable maximum.
 * @returns What the setting is, and the model's maximum when it is known.
 */
export function formatContextLengthNote(
  modelKey: string,
  maximumText: string | null
): string {
  return maximumText === null
    ? "Tokens the weights can hold at once."
    : `Tokens the weights can hold at once. ${modelKey} tops out at ${maximumText}.`
}

/**
 * Formats the line shown when no model's load configuration can be edited.
 *
 * @param inventoryStatus - Latest inventory observation status.
 * @returns A request to choose a default model when the inventory is ready,
 * otherwise that the model list is needed first.
 */
export function formatLoadConfigurationEmptyMessage(
  inventoryStatus: ModelInventoryState["status"]
): string {
  switch (inventoryStatus) {
    case "ready":
      return "Choose a default model above to edit its load configuration."
    case "unavailable":
    case "failed":
      return "Load configurations can be edited once the models are listed."
  }
}
