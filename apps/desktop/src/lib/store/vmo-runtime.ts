import type { StoreApi } from "zustand"

import {
  getVmoStatus,
  startVmo as startVmoProcess,
  stopVmo as stopVmoProcess
} from "@/lib/apis/tauri/vmo"

import { getVmoReadiness, type VmoReadiness } from "./vmo-readiness"

/**
 * vmo lifecycle states tracked by the store.
 *
 * @remarks `running` means vmo answered its health route, so the backend
 * offers `read_page`. `unresponsive` means the process stayed alive without
 * answering within the readiness timeout, or a start or stop failed while it
 * still ran or while its status could not be read; stopping it is the
 * recovery path.
 */
export type VmoServerStatus =
  "running" | "starting" | "stopping" | "stopped" | "unresponsive"

/**
 * What went wrong with the last start or stop of vmo.
 *
 * @remarks `killed`: vmo did not exit within the stop timeout and was
 * killed, so it may have left VMs running. `start-failed` and `stop-failed`
 * carry the host's reason.
 */
export type VmoProblem =
  | { readonly kind: "killed" }
  | {
      readonly kind: "start-failed"
      /** Host's reason, as it gave it. */
      readonly message: string
    }
  | {
      readonly kind: "stop-failed"
      /** Host's reason, as it gave it. */
      readonly message: string
    }

/** Problem of a start or a stop that failed. */
type VmoCommandFailure = Extract<
  VmoProblem,
  { readonly kind: "start-failed" | "stop-failed" }
>

/**
 * vmo lifecycle state and the problem of the last start or stop, which lasts
 * until the next start or stop.
 *
 * @remarks Only a stopped or unresponsive vmo has a problem, and an
 * unresponsive one only the failure of a start or a stop.
 */
export type VmoServerInfo =
  | {
      readonly status: "starting" | "running" | "stopping"
      readonly problem: null
    }
  | {
      readonly status: "stopped"
      readonly problem: VmoProblem | null
    }
  | {
      readonly status: "unresponsive"
      readonly problem: VmoCommandFailure | null
    }

/** vmo lifecycle state and actions composed into the application store. */
export type VmoRuntimeSlice = {
  /** Current vmo lifecycle state and problem. */
  readonly vmoServerInfo: VmoServerInfo
  /**
   * Starts vmo unless the desktop owns a running one, and waits until it
   * answers its health route, exits, or the readiness timeout passes.
   *
   * @returns Resolves after `running`, `unresponsive`, or `stopped` is
   * published, or after a newer transition superseded the start; never
   * rejects. A failed start publishes `start-failed` with `stopped`, or with
   * `unresponsive` while vmo still runs or its status cannot be read.
   */
  readonly startVmo: () => Promise<void>
  /**
   * Stops the owned vmo and waits until it exited, up to one minute while it
   * deletes its VMs.
   *
   * @returns Resolves after `stopped` or, when the stop failed while vmo
   * still runs, `unresponsive` is published; never rejects. A kill or a
   * failure is published as the problem.
   */
  readonly stopVmo: () => Promise<void>
}

/** Published while a stop waits for vmo. */
const STOPPING_VMO: VmoServerInfo = Object.freeze({
  status: "stopping",
  problem: null
})

/** Published for a vmo that stopped without a problem. */
const STOPPED_VMO: VmoServerInfo = Object.freeze({
  status: "stopped",
  problem: null
})

/** Published for a vmo that answers its health route. */
const RUNNING_VMO: VmoServerInfo = Object.freeze({
  status: "running",
  problem: null
})

/** Published for a vmo that runs without answering its health route. */
const UNRESPONSIVE_VMO: VmoServerInfo = Object.freeze({
  status: "unresponsive",
  problem: null
})

/** Problem of a vmo killed after the stop timeout. */
const KILLED_VMO_PROBLEM: VmoProblem = Object.freeze({ kind: "killed" })

/** Published for a vmo killed after the stop timeout. */
const KILLED_VMO: VmoServerInfo = Object.freeze({
  status: "stopped",
  problem: KILLED_VMO_PROBLEM
})

/** State published for each readiness outcome of a start. */
const VMO_SERVER_INFO_BY_READINESS = Object.freeze({
  ready: RUNNING_VMO,
  unresponsive: UNRESPONSIVE_VMO,
  exited: STOPPED_VMO
} satisfies Readonly<Record<VmoReadiness, VmoServerInfo>>)

/**
 * Formats the reason a Tauri vmo command rejected with, for the card's
 * problem line.
 *
 * @param rejection - Value the command rejected with: the host's error
 * string, or an error of the IPC layer.
 * @returns The non-empty reason, or a fallback sentence when it has none.
 */
function formatVmoCommandRejection(rejection: unknown): string {
  if (typeof rejection === "string" && rejection !== "") return rejection
  if (rejection instanceof Error && rejection.message !== "") {
    return rejection.message
  }
  return "the host gave no reason"
}

/**
 * Gets the status to show for the owned vmo after a failed start or stop.
 *
 * @returns `unresponsive` while its process is alive, running or still
 * stopping, or when its status cannot be read, so Stop stays offered and
 * joins a stop in progress; `stopped` once the host owns no running vmo.
 */
async function getVmoServerStatusAfterFailure(): Promise<
  "unresponsive" | "stopped"
> {
  try {
    const { status } = await getVmoStatus()
    return status === "stopped" ? "stopped" : "unresponsive"
  } catch {
    return "unresponsive"
  }
}

/**
 * Registers vmo lifecycle state and actions with one Zustand owner.
 *
 * @param set - Framework setter for atomic state updates.
 * @param get - Framework reader for the current state.
 * @returns The initial stopped state and its actions.
 * @remarks The Tauri host owns the vmo process; this slice owns what the
 * renderer shows about it. A start publishes its outcome only while the
 * `starting` state it published is still current, so a stop or a newer start
 * that took over wins. Neither action rejects: the Runtime pane shows a
 * failure as the problem.
 */
export function createVmoRuntimeSlice(
  set: StoreApi<VmoRuntimeSlice>["setState"],
  get: StoreApi<VmoRuntimeSlice>["getState"]
): VmoRuntimeSlice {
  /**
   * Publishes `info` unless a newer transition replaced the start.
   *
   * @param starting - State the start published when it began; it is never
   * shared with another start, so any later transition replaces it.
   * @param info - State the start settled on.
   */
  function updateStartedVmoServerInfo(
    starting: VmoServerInfo,
    info: VmoServerInfo
  ): void {
    if (get().vmoServerInfo !== starting) return
    set({ vmoServerInfo: info })
  }

  /** Implements {@link VmoRuntimeSlice.startVmo}. */
  async function startVmo(): Promise<void> {
    const starting: VmoServerInfo = Object.freeze({
      status: "starting",
      problem: null
    })
    set({ vmoServerInfo: starting })
    try {
      const isProcessRunning =
        (await getVmoStatus()).status === "running" ||
        (await startVmoProcess()).status === "running"
      const readiness = isProcessRunning ? await getVmoReadiness() : "exited"
      updateStartedVmoServerInfo(
        starting,
        VMO_SERVER_INFO_BY_READINESS[readiness]
      )
    } catch (error) {
      const problem: VmoCommandFailure = {
        kind: "start-failed",
        message: formatVmoCommandRejection(error)
      }
      const status = await getVmoServerStatusAfterFailure()
      const info: VmoServerInfo = { status, problem }
      updateStartedVmoServerInfo(starting, info)
    }
  }

  /** Implements {@link VmoRuntimeSlice.stopVmo}. */
  async function stopVmo(): Promise<void> {
    try {
      if ((await getVmoStatus()).status === "stopped") {
        set({ vmoServerInfo: STOPPED_VMO })
        return
      }
      set({ vmoServerInfo: STOPPING_VMO })
      const outcome = await stopVmoProcess()
      set({
        vmoServerInfo: outcome.status === "killed" ? KILLED_VMO : STOPPED_VMO
      })
    } catch (error) {
      const problem: VmoCommandFailure = {
        kind: "stop-failed",
        message: formatVmoCommandRejection(error)
      }
      const status = await getVmoServerStatusAfterFailure()
      const vmoServerInfo: VmoServerInfo = { status, problem }
      set({ vmoServerInfo })
    }
  }

  return { vmoServerInfo: STOPPED_VMO, startVmo, stopVmo }
}
