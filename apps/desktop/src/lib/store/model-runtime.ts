import type { LlmInfo, LlmTestModelApiResponse } from "@lys/protocol"

/** Inventory observation; failed and unavailable states never imply an empty runtime. */
export type ModelInventoryState =
  | { readonly status: "unavailable" }
  | { readonly status: "failed" }
  | { readonly status: "ready"; readonly models: readonly LlmInfo[] }

/** One application-owned model request; mutations are serialized in the renderer. */
export type ModelRequestState =
  | { readonly status: "idle" }
  | { readonly status: "listing" }
  | {
      readonly status: "loading" | "unloading" | "testing"
      readonly modelKey: string
    }

/**
 * Compact residency summary for the runtime card and composer.
 * @remarks Several models may be loaded. The summary prefers the loaded default,
 * then the first loaded inventory entry. Unknown means observation failed.
 */
export type ModelRuntimeState =
  | { readonly status: "none" }
  | { readonly status: "unknown" }
  | {
      readonly status: "loading" | "loaded" | "unloading"
      readonly modelKey: string
    }

/** Observable model state atomically replaced by the application store. */
export type ModelState = {
  /** Latest complete inventory observation. */
  readonly modelInventory: ModelInventoryState
  /** Current renderer request, or idle after settlement. */
  readonly modelRequest: ModelRequestState
  /** Summary derived atomically from inventory, request, and default. */
  readonly modelRuntime: ModelRuntimeState
  /** Latest safe request failure; null when no failure is shown. */
  readonly modelError: string | null
  /** Latest health observation, cleared by the next operation. */
  readonly modelHealth: LlmTestModelApiResponse | null
}

/** Initial model state before a backend inventory observation. */
export const initialModelState: ModelState = Object.freeze({
  modelInventory: Object.freeze({ status: "unavailable" }),
  modelRequest: Object.freeze({ status: "idle" }),
  modelRuntime: Object.freeze({ status: "none" }),
  modelError: null,
  modelHealth: null
})

/**
 * Projects inventory into the compact residency summary.
 * @param inventory - Latest authoritative inventory observation.
 * @param request - Current renderer operation.
 * @param defaultModel - Preferred model, without claiming it is loaded.
 * @returns The transition, preferred loaded model, confirmed absence, or unknown state.
 */
export function buildModelRuntime(
  inventory: ModelInventoryState,
  request: ModelRequestState,
  defaultModel: string | null
): ModelRuntimeState {
  if (request.status === "loading" || request.status === "unloading") {
    return { status: request.status, modelKey: request.modelKey }
  }
  if (inventory.status === "failed") return { status: "unknown" }
  if (inventory.status === "unavailable") return { status: "none" }
  const loaded =
    inventory.models.find(
      (model) => model.loaded && model.modelKey === defaultModel
    ) ?? inventory.models.find((model) => model.loaded)
  return loaded
    ? { status: "loaded", modelKey: loaded.modelKey }
    : { status: "none" }
}

/**
 * Reports whether weights are in transition.
 * @param modelRuntime - Current residency summary.
 * @returns True while a load or unload awaits backend settlement.
 */
export function isModelTransitionInFlight(
  modelRuntime: ModelRuntimeState
): boolean {
  return (
    modelRuntime.status === "loading" || modelRuntime.status === "unloading"
  )
}
