import type { BackendServerStatus } from "@/lib/store"
import type { ModelRuntimeState } from "@/lib/store/model-runtime"

import { LOCAL_MODEL_INVENTORY, type LocalModelDescriptor } from "./inventory"

/** Visual tone the status indicator uses for a residency state. */
export type ModelResidencyTone = "active" | "pending" | "idle"

/**
 * Reads the on-disk size of known weights.
 *
 * @param modelKey - Weights to look up in the placeholder inventory.
 * @returns The size label, or `unknown size` for weights outside the inventory.
 */
function findModelSizeLabel(modelKey: string): string {
  const model = LOCAL_MODEL_INVENTORY.find(
    (candidate) => candidate.modelKey === modelKey
  )

  return model?.sizeLabel ?? "unknown size"
}

/**
 * Names the weights currently resident in memory.
 *
 * @param modelRuntime - Current residency state.
 * @returns The resident model identifier, or `null` while none is loaded.
 */
export function readLoadedModelKey(
  modelRuntime: ModelRuntimeState
): string | null {
  return modelRuntime.status === "loaded" ? modelRuntime.modelKey : null
}

/**
 * Selects the status tone for a residency state.
 *
 * @param modelRuntime - Current residency state.
 * @returns The tone name consumed by the status indicator's styles.
 */
export function readModelResidencyTone(
  modelRuntime: ModelRuntimeState
): ModelResidencyTone {
  switch (modelRuntime.status) {
    case "loaded":
      return "active"
    case "loading":
    case "unloading":
      return "pending"
    case "none":
      return "idle"
  }
}

/**
 * Selects the status tone for one model row.
 *
 * @param modelRuntime - Current residency state.
 * @param modelKey - Weights the row represents.
 * @returns The row's tone; rows the current state does not name stay idle.
 */
export function readModelRowTone(
  modelRuntime: ModelRuntimeState,
  modelKey: string
): ModelResidencyTone {
  if (modelRuntime.status === "none") return "idle"
  if (modelRuntime.modelKey !== modelKey) return "idle"

  return readModelResidencyTone(modelRuntime)
}

/**
 * Formats the residency heading shown on the runtime pane's model card.
 *
 * @param modelRuntime - Current residency state.
 * @returns The heading naming the state the weights are in.
 */
export function formatModelResidencyHeading(
  modelRuntime: ModelRuntimeState
): string {
  switch (modelRuntime.status) {
    case "loaded":
      return "Model loaded"
    case "loading":
      return "Loading weights"
    case "unloading":
      return "Unloading"
    case "none":
      return "No model loaded"
  }
}

/**
 * Formats the supporting line shown while no weights are resident.
 *
 * @param backendStatus - Store-owned backend process lifecycle state.
 * @param defaultModel - Persisted default model identifier, when one is chosen.
 * @returns The reason nothing is in memory, naming what to do about it.
 */
function formatAbsentResidencyMeta(
  backendStatus: BackendServerStatus,
  defaultModel: string | null
): string {
  if (backendStatus !== "running") return "start the backend first"
  if (defaultModel === null) {
    return "no default model chosen · pick one in Model"
  }

  return `${defaultModel} is default · not in memory`
}

/**
 * Formats the supporting line under the residency heading.
 *
 * @param modelRuntime - Current residency state.
 * @param backendStatus - Store-owned backend process lifecycle state.
 * @param defaultModel - Persisted default model identifier, when one is chosen.
 * @returns The weights and size the state refers to, or why none are resident.
 */
export function formatModelResidencyMeta(
  modelRuntime: ModelRuntimeState,
  backendStatus: BackendServerStatus,
  defaultModel: string | null
): string {
  switch (modelRuntime.status) {
    case "loaded":
      return `${modelRuntime.modelKey} · ${findModelSizeLabel(modelRuntime.modelKey)} resident`
    case "loading":
      return `${modelRuntime.modelKey} · ${findModelSizeLabel(modelRuntime.modelKey)}`
    case "unloading":
      return `releasing ${findModelSizeLabel(modelRuntime.modelKey)}`
    case "none":
      return formatAbsentResidencyMeta(backendStatus, defaultModel)
  }
}

/**
 * Formats the tag shown at the end of one model row.
 *
 * @param modelRuntime - Current residency state.
 * @param model - Weights the row represents.
 * @returns The row's state when it is the one in play, otherwise its disk size.
 */
export function formatModelRowTag(
  modelRuntime: ModelRuntimeState,
  model: LocalModelDescriptor
): string {
  if (
    modelRuntime.status !== "none" &&
    modelRuntime.modelKey === model.modelKey
  ) {
    return modelRuntime.status
  }

  return `${model.sizeLabel} on disk`
}

/**
 * Formats the tag shown at the end of one row in the composer's weights menu.
 *
 * @param modelRuntime - Current residency state.
 * @param model - Weights the row represents.
 * @param selectedModelKey - Persisted default model identifier, when chosen.
 * @returns The row's live condition when it has one, otherwise whether it is
 * merely the chosen default, otherwise its on-disk size. Resident weights read
 * as `resident` here rather than `loaded`, because the menu answers "which
 * weights are answering me" rather than "what is in memory".
 */
export function formatComposerModelRowTag(
  modelRuntime: ModelRuntimeState,
  model: LocalModelDescriptor,
  selectedModelKey: string | null
): string {
  if (
    modelRuntime.status !== "none" &&
    modelRuntime.modelKey === model.modelKey
  ) {
    return modelRuntime.status === "loaded" ? "resident" : modelRuntime.status
  }

  if (model.modelKey === selectedModelKey) return "selected"

  return `${model.sizeLabel} on disk`
}
