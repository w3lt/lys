import type { LlmInfo } from "@lys/protocol"

/** Whether a loaded model can be offered tools. */
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
 * Calculates whether a loaded model can be offered tools.
 *
 * @param loadedModel - Inventory entry of the model, which says how it was
 * trained, while it is loaded; undefined while it is not, or there is no
 * model.
 * @returns `trained` or `untrained` for a loaded model, and `unknown`
 * otherwise.
 */
export function calculateToolModelSupport(
  loadedModel: LlmInfo | undefined
): ToolModelSupport {
  if (loadedModel === undefined) return UNKNOWN_TOOL_MODEL_SUPPORT

  return Object.freeze({
    status: loadedModel.trainedForToolUse ? "trained" : "untrained",
    modelKey: loadedModel.modelKey
  } satisfies ToolModelSupport)
}
