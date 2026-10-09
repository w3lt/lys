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
 * Arranges runtime facts in a fresh application store.
 *
 * @param store - Application store of the case, freshly imported.
 * @param runtime - Facts to arrange.
 * @remarks The residency summary is derived from the inventory and the
 * default model with the store's own projection, so the arranged state is
 * one the store could reach. Every other field keeps its initial value.
 */
export function arrangeRuntime(
  store: typeof useLysStore,
  runtime: RuntimeArrangement
): void {
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
