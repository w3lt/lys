import type { BackendServerStatus } from "@/lib/store"
import type { ModelRuntimeState } from "@/lib/store/model-runtime"

import type { LocalModelDescriptor } from "./inventory"

/** Visual tone the status indicator uses for a residency state. */
export type ModelResidencyTone = "active" | "pending" | "idle"

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
 * Finds the observed loaded model eligible for chat submission.
 *
 * @param backendStatus - Store-owned backend process lifecycle state.
 * @param modelRuntime - Validated runtime projection shared with the Composer.
 * @returns The resident model key while the backend is running, or `null`
 * when either prerequisite is unavailable.
 */
export function findEligibleChatModel(
  backendStatus: BackendServerStatus,
  modelRuntime: ModelRuntimeState
): string | null {
  return backendStatus === "running" ? readLoadedModelKey(modelRuntime) : null
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
    case "unknown":
      return "idle"
  }
}

/**
 * Selects the status tone for one model row.
 *
 * @param modelRuntime - Current residency state.
 * @param model - Inventory entry the row represents.
 * @returns The row's tone; rows the current state does not name stay idle.
 */
export function readModelRowTone(
  modelRuntime: ModelRuntimeState,
  model: LocalModelDescriptor
): ModelResidencyTone {
  if (modelRuntime.status === "unknown") return "idle"
  if (
    modelRuntime.status !== "none" &&
    modelRuntime.modelKey === model.modelKey
  ) {
    return readModelResidencyTone(modelRuntime)
  }
  return model.loaded ? "active" : "idle"
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
    case "unknown":
      return "Model state unavailable"
  }
}

/**
 * Formats the supporting line shown while no weights are resident.
 *
 * @param backendStatus - Store-owned backend process lifecycle state.
 * @param defaultModel - Current default model identifier, when one is chosen.
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
 * @param defaultModel - Current default model identifier, when one is chosen.
 * @returns The observed weights or the reason residency is unavailable.
 */
export function formatModelResidencyMeta(
  modelRuntime: ModelRuntimeState,
  backendStatus: BackendServerStatus,
  defaultModel: string | null
): string {
  switch (modelRuntime.status) {
    case "loaded":
      return `${modelRuntime.modelKey} · loaded in LM Studio`
    case "loading":
      return modelRuntime.modelKey
    case "unloading":
      return `releasing ${modelRuntime.modelKey}`
    case "unknown":
      return "refresh the model inventory to check loaded weights"
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
    modelRuntime.status !== "unknown" &&
    modelRuntime.modelKey === model.modelKey
  ) {
    return modelRuntime.status
  }

  if (modelRuntime.status === "unknown") return "state unavailable"
  if (model.loaded) return "loaded"
  return `${model.sizeLabel} on disk`
}

/**
 * Formats the tag shown at the end of one row in the composer's weights menu.
 *
 * @param modelRuntime - Current residency state.
 * @param model - Weights the row represents.
 * @param selectedModelKey - Current default model identifier, when chosen.
 * @returns The row's live condition when it has one, otherwise whether it is
 * merely the chosen default, otherwise its on-disk size. A resident tag reports
 * loaded weights for this row, including models outside the runtime projection.
 */
export function formatComposerModelRowTag(
  modelRuntime: ModelRuntimeState,
  model: LocalModelDescriptor,
  selectedModelKey: string | null
): string {
  if (
    modelRuntime.status !== "none" &&
    modelRuntime.status !== "unknown" &&
    modelRuntime.modelKey === model.modelKey
  ) {
    return modelRuntime.status === "loaded" ? "resident" : modelRuntime.status
  }

  if (modelRuntime.status === "unknown") return "state unavailable"
  if (model.loaded) return "resident"
  if (model.modelKey === selectedModelKey) return "selected"

  return `${model.sizeLabel} on disk`
}
