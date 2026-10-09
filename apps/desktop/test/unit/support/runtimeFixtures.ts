import type { BackendServerStatus, useLysStore } from "@/lib/store"
import type { LmStudioStatus } from "@/lib/store/lm-studio-status"
import {
  buildModelRuntime,
  type ModelInventoryState
} from "@/lib/store/model-runtime"
import { buildLlmInfo } from "./modelFixtures"

/** Runtime facts a case arranges in the application store. */
export type RuntimeArrangement = Readonly<{
  /** Backend lifecycle state. */
  backendStatus: BackendServerStatus
  /** Latest LM Studio status the backend reported. */
  lmStudioStatus: LmStudioStatus
  /** Latest model inventory observation. */
  modelInventory: ModelInventoryState
  /** Default model chosen in settings, or null when none is. */
  defaultModel: string | null
}>

/** Backend running, LM Studio connected, and `qwen3-8b` loaded and chosen. */
export const READY_RUNTIME: RuntimeArrangement = Object.freeze({
  backendStatus: "running",
  lmStudioStatus: "connected",
  modelInventory: Object.freeze({
    status: "ready",
    models: Object.freeze([buildLlmInfo("qwen3-8b", { loaded: true })])
  }),
  defaultModel: "qwen3-8b"
})

/**
 * Builds a runtime in which LM Studio cannot be reached, with `qwen3-8b`
 * still chosen as the default.
 *
 * @param backendStatus - Backend lifecycle state.
 * @param lmStudioStatus - LM Studio status; only `connected` with a running
 * backend makes the runtime reachable, so a case passes another one.
 * @returns The arrangement, with the inventory released as the application
 * store releases it whenever the runtime becomes unreachable.
 */
export function buildUnreachableRuntime(
  backendStatus: BackendServerStatus,
  lmStudioStatus: LmStudioStatus = "unknown"
): RuntimeArrangement {
  return Object.freeze({
    backendStatus,
    lmStudioStatus,
    modelInventory: Object.freeze({ status: "unavailable" }),
    defaultModel: READY_RUNTIME.defaultModel
  })
}

/**
 * Arranges runtime facts in a fresh application store.
 *
 * @param store - Application store of the case, freshly imported.
 * @param runtime - Facts to arrange.
 * @throws When the facts hold an inventory while LM Studio cannot be
 * reached; the store releases the inventory then, so such a state cannot
 * occur.
 * @remarks The residency summary is derived from the inventory and the
 * default model with the store's own projection, so the arranged state is
 * one the store could reach. Every other field keeps its initial value.
 */
export function arrangeRuntime(
  store: typeof useLysStore,
  runtime: RuntimeArrangement
): void {
  const isReachable =
    runtime.backendStatus === "running" &&
    runtime.lmStudioStatus === "connected"
  if (!isReachable && runtime.modelInventory.status !== "unavailable") {
    throw new Error(
      "The store holds no inventory while LM Studio cannot be reached"
    )
  }
  const { settings } = store.getState()
  store.setState({
    backendServerInfo: { status: runtime.backendStatus },
    lmStudioStatus: runtime.lmStudioStatus,
    modelInventory: runtime.modelInventory,
    modelRuntime: buildModelRuntime(
      runtime.modelInventory,
      { status: "idle" },
      runtime.defaultModel
    ),
    settings: {
      ...settings,
      runtime: { ...settings.runtime, defaultModel: runtime.defaultModel }
    }
  })
}
