/**
 * Weight residency as the renderer models it, plus the timings that currently
 * stand in for a real load.
 *
 * @remarks The durations here simulate work the backend does not yet report.
 * `POST /api/v1/llm/load` exists but answers only once, with no progress, and
 * no unload endpoint exists at all. Until both are wired, the store drives this
 * state machine on timers so the lifecycle's rendered states are settled;
 * replacing the simulation means swapping the store's two transitions, not
 * reshaping this contract.
 */

/**
 * Residency of the selected weights, as one closed lifecycle.
 *
 * @remarks `modelKey` names the weights the status refers to, so a transition
 * always says which model it is about. There is deliberately no progress value:
 * nothing measures a real load, and a fabricated percentage would misreport it.
 */
export type ModelRuntimeState =
  | { readonly status: "none" }
  | { readonly status: "loading"; readonly modelKey: string }
  | { readonly status: "loaded"; readonly modelKey: string }
  | { readonly status: "unloading"; readonly modelKey: string }

/**
 * How long a simulated load runs before the weights report as resident.
 *
 * @remarks Milliseconds. Stands in for the unreported duration of a real load.
 */
export const SIMULATED_MODEL_LOAD_MS = 1400

/**
 * How long a simulated unload runs before the weights report as released.
 *
 * @remarks Milliseconds. Releasing is quicker than loading, as it is in LM
 * Studio.
 */
export const SIMULATED_MODEL_UNLOAD_MS = 700

/** Residency state before anything has been loaded in this session. */
export const initialModelRuntimeState: ModelRuntimeState = { status: "none" }

/**
 * Reports whether the weights are mid-transition.
 *
 * @param modelRuntime - Current residency state.
 * @returns True while a load or unload has been requested and has not settled.
 */
export function isModelTransitionInFlight(
  modelRuntime: ModelRuntimeState
): boolean {
  return (
    modelRuntime.status === "loading" || modelRuntime.status === "unloading"
  )
}
