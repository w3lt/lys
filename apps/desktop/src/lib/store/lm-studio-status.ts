import type { LlmRuntimeConnectionStatus } from "@lys/protocol"
import type { StoreApi } from "zustand"
import type { ModelApiConnection } from "@/lib/apis/http/models"
import {
  connectLlmRuntime,
  getLlmRuntimeConnectionStatus
} from "@/lib/apis/http/runtime"

/**
 * LM Studio connection status shown by the desktop.
 *
 * @remarks `unknown` means the backend is not running or its status could
 * not be read; the other values mirror the backend's runtime connection.
 */
export type LmStudioStatus = "unknown" | LlmRuntimeConnectionStatus

/** Backend origin and readiness sampled from the owning store. */
export type LmStudioBackendConnection = {
  /** Backend origin used for status requests. */
  readonly backendUrl: string
  /** Whether the backend's health route answered, so status requests are admitted. */
  readonly isBackendRunning: boolean
}

/** Store capabilities the LM Studio status slice reads and notifies. */
export type LmStudioStatusSliceDependencies = {
  /** Reads the current backend origin and readiness. */
  readonly getBackendConnection: () => LmStudioBackendConnection
  /** Receives each changed status after it is published. */
  readonly handleLmStudioStatusChange: (lmStudioStatus: LmStudioStatus) => void
}

/** LM Studio status state and actions composed into the application store. */
export type LmStudioStatusSlice = {
  /** Latest published LM Studio status. */
  readonly lmStudioStatus: LmStudioStatus
  /**
   * Reads and publishes the backend's status; a `connecting` status is then
   * replaced by the settled result of the backend's pending attempt.
   *
   * @returns Resolves after publication or supersession; never rejects.
   */
  updateLmStudioStatus: () => Promise<void>
  /**
   * Asks the backend to connect to LM Studio again, publishing `connecting`
   * first and then the settled status.
   *
   * @returns Resolves after publication or supersession; never rejects.
   */
  connectLmStudio: () => Promise<void>
  /** Publishes `unknown` and abandons the current status request. */
  resetLmStudioStatus: () => void
}

/** One backend request producing a connection status. */
type LmStudioStatusRequest = (
  connection: ModelApiConnection
) => Promise<LlmRuntimeConnectionStatus>

/**
 * Registers LM Studio status state and actions with one Zustand owner.
 *
 * @param set - Framework setter for atomic status updates.
 * @param get - Framework reader for the current status.
 * @param dependencies - Backend connection reader and status-change reaction.
 * @returns The initial `unknown` status and its actions.
 * @remarks One status request is current at a time; a new request or a reset
 * abandons the previous one locally. A response is published only while its
 * request is current and the backend still runs. A failed request publishes
 * `unknown`. Requests are admitted only while the backend runs.
 */
export function createLmStudioStatusSlice(
  set: StoreApi<LmStudioStatusSlice>["setState"],
  get: StoreApi<LmStudioStatusSlice>["getState"],
  dependencies: LmStudioStatusSliceDependencies
): LmStudioStatusSlice {
  let currentRequest: AbortController | null = null

  /**
   * Publishes a status and notifies the store when it changed.
   *
   * @param lmStudioStatus - Status to publish.
   */
  function updateLmStudioStatusValue(lmStudioStatus: LmStudioStatus): void {
    if (get().lmStudioStatus === lmStudioStatus) return
    set({ lmStudioStatus })
    dependencies.handleLmStudioStatusChange(lmStudioStatus)
  }

  /**
   * Owns one status request from admission to publication.
   *
   * @param request - Backend request producing the status.
   * @returns Resolves to the published status, or `null` when the request was
   * not admitted or was superseded; never rejects.
   */
  async function startLmStudioStatusRequest(
    request: LmStudioStatusRequest
  ): Promise<LmStudioStatus | null> {
    const { backendUrl, isBackendRunning } = dependencies.getBackendConnection()
    if (!isBackendRunning) return null
    currentRequest?.abort()
    const controller = new AbortController()
    currentRequest = controller
    const lmStudioStatus = await request({
      backendUrl,
      signal: controller.signal
    }).catch((): LmStudioStatus => "unknown")
    if (currentRequest !== controller) return null
    currentRequest = null
    if (!dependencies.getBackendConnection().isBackendRunning) return null
    updateLmStudioStatusValue(lmStudioStatus)
    return lmStudioStatus
  }

  /**
   * Implements {@link LmStudioStatusSlice.updateLmStudioStatus}.
   *
   * @remarks A published `connecting` status is followed by a connect request
   * that joins the backend's pending attempt; if that attempt settled in the
   * meantime, the request starts a new one.
   */
  async function updateLmStudioStatus(): Promise<void> {
    const lmStudioStatus = await startLmStudioStatusRequest(
      getLlmRuntimeConnectionStatus
    )
    if (lmStudioStatus === "connecting") {
      await startLmStudioStatusRequest(connectLlmRuntime)
    }
  }

  /** Implements {@link LmStudioStatusSlice.connectLmStudio}. */
  async function connectLmStudio(): Promise<void> {
    if (!dependencies.getBackendConnection().isBackendRunning) return
    updateLmStudioStatusValue("connecting")
    await startLmStudioStatusRequest(connectLlmRuntime)
  }

  /** Implements {@link LmStudioStatusSlice.resetLmStudioStatus}. */
  function resetLmStudioStatus(): void {
    currentRequest?.abort()
    currentRequest = null
    updateLmStudioStatusValue("unknown")
  }

  return {
    lmStudioStatus: "unknown",
    updateLmStudioStatus,
    connectLmStudio,
    resetLmStudioStatus
  }
}
