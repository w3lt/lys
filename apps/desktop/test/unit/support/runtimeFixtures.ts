import type { BackendServerStatus, useLysStore } from "@/lib/store"
import {
  INITIAL_PROVIDER_MODEL_STATES,
  updateProviderModelState,
  type LlmProviderStatus,
  type ModelInventoryState
} from "@/lib/store/model-runtime"
import { buildLlmInfo } from "./modelFixtures"

/**
 * Runtime facts a case arranges in the application store, for LM Studio, the
 * provider the first-run settings turn on.
 */
export type RuntimeArrangement = Readonly<{
  /** Backend lifecycle state. */
  backendStatus: BackendServerStatus
  /** Latest LM Studio status the backend reported. */
  lmStudioStatus: LlmProviderStatus
  /** Latest LM Studio inventory observation. */
  modelInventory: ModelInventoryState
  /** Key of the LM Studio model chosen as the default, or null when none is. */
  defaultModel: string | null
}>

/**
 * Backend running, LM Studio connected, and `qwen3-8b` loaded with an
 * 8,192-token context and chosen.
 */
export const READY_RUNTIME: RuntimeArrangement = Object.freeze({
  backendStatus: "running",
  lmStudioStatus: "connected",
  modelInventory: Object.freeze({
    status: "ready",
    modelLoading: "lys",
    models: Object.freeze([
      buildLlmInfo("qwen3-8b", { loaded: true, loadedContextLength: 8192 })
    ])
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
  lmStudioStatus: LlmProviderStatus = "unknown"
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
 * @remarks LM Studio is turned on as the only provider, as the first-run
 * settings turn it on; its state holds the status and the inventory with no
 * request in flight, and the default names an LM Studio model. Every other
 * provider keeps its initial state, and every other field its current value.
 */
export function updateStoreRuntime(
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
    providerModels: updateProviderModelState(
      INITIAL_PROVIDER_MODEL_STATES,
      "lmStudio",
      { status: runtime.lmStudioStatus, inventory: runtime.modelInventory }
    ),
    settings: {
      ...settings,
      providers: { ...settings.providers, enabled: ["lmStudio"] },
      runtime: {
        ...settings.runtime,
        defaultModel:
          runtime.defaultModel === null
            ? null
            : { provider: "lmStudio", modelKey: runtime.defaultModel }
      }
    }
  })
}
