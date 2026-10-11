import type {
  ModelInventoryState,
  ModelRuntimeState
} from "@/lib/store/model-runtime"

/** Whether the loaded model can be offered tools. */
export type ToolModelSupport =
  | {
      /** No model is loaded, or the inventory cannot say how it was trained. */
      readonly status: "unknown"
    }
  | {
      /** The loaded model was trained to call tools. */
      readonly status: "trained"
      /** Key of the loaded model. */
      readonly modelKey: string
    }
  | {
      /** The loaded model was not trained to call tools; it is offered none. */
      readonly status: "untrained"
      /** Key of the loaded model. */
      readonly modelKey: string
    }

/** Support of a model whose training is not known. */
const UNKNOWN_TOOL_MODEL_SUPPORT: ToolModelSupport = Object.freeze({
  status: "unknown"
})

/**
 * Calculates whether the loaded model can be offered tools.
 *
 * @param modelRuntime - Residency summary; only a loaded model counts.
 * @param modelInventory - Latest inventory, which says how each model was
 * trained.
 * @returns `trained` or `untrained` for a loaded model listed in a ready
 * inventory, and `unknown` otherwise.
 */
export function calculateToolModelSupport(
  modelRuntime: ModelRuntimeState,
  modelInventory: ModelInventoryState
): ToolModelSupport {
  if (modelRuntime.status !== "loaded" || modelInventory.status !== "ready") {
    return UNKNOWN_TOOL_MODEL_SUPPORT
  }

  const loadedModel = modelInventory.models.find(
    (model) => model.modelKey === modelRuntime.modelKey
  )
  if (loadedModel === undefined) return UNKNOWN_TOOL_MODEL_SUPPORT

  return Object.freeze({
    status: loadedModel.trainedForToolUse ? "trained" : "untrained",
    modelKey: loadedModel.modelKey
  } satisfies ToolModelSupport)
}
