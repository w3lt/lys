import type {
  ModelInventoryState,
  ModelRuntimeState
} from "@/lib/store/model-runtime"

import { findLoadedModel } from "./model-residency"

/** What the loaded model can take as attachments. */
export type AttachmentModelSupport = Readonly<{
  /** Whether the model sees the images sent with a message. */
  vision: boolean
  /**
   * Whether the model was trained to call tools, which reading an attached
   * text file takes.
   */
  trainedForToolUse: boolean
}>

/**
 * Calculates what the loaded model can take as attachments.
 *
 * @param modelRuntime - Residency summary; only a loaded model counts.
 * @param modelInventory - Latest inventory, which says whether each model
 * has vision and was trained for tool use.
 * @returns The loaded model's support while a ready inventory lists it, and
 * undefined otherwise.
 */
export function calculateAttachmentModelSupport(
  modelRuntime: ModelRuntimeState,
  modelInventory: ModelInventoryState
): AttachmentModelSupport | undefined {
  const loadedModel = findLoadedModel(modelRuntime, modelInventory)
  if (loadedModel === undefined) return undefined

  return Object.freeze({
    vision: loadedModel.vision,
    trainedForToolUse: loadedModel.trainedForToolUse
  })
}
