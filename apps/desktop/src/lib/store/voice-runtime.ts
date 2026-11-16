import type { StoreApi } from "zustand"

import {
  getVoiceStatus,
  startVoice as startVoiceProcess,
  stopVoice as stopVoiceProcess
} from "@/lib/apis/tauri/voice"

import { getVoiceReadiness, type VoiceReadiness } from "./voice-readiness"

/**
 * voice lifecycle states tracked by the store.
 *
 * @remarks `running` means voice answered its health route, so Lys can
 * speak. `unresponsive` means the process stayed alive without answering
 * within the readiness timeout, or a start or stop failed while it still ran
 * or while its status could not be read; stopping it is the recovery path.
 */
export type VoiceServerStatus =
  "running" | "starting" | "stopping" | "stopped" | "unresponsive"

/**
 * What went wrong with the last start or stop of voice.
 *
 * @remarks `killed`: voice did not exit within the stop timeout and was
 * killed. `start-failed` and `stop-failed` carry the host's reason.
 */
export type VoiceProblem =
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
type VoiceCommandFailure = Extract<
  VoiceProblem,
  { readonly kind: "start-failed" | "stop-failed" }
>

/**
 * voice lifecycle state and the problem of the last start or stop, which
 * lasts until the next start or stop.
 *
 * @remarks Only a stopped or unresponsive voice has a problem, and an
 * unresponsive one only the failure of a start or a stop.
 */
export type VoiceServerInfo =
  | {
      readonly status: "starting" | "running" | "stopping"
      readonly problem: null
    }
  | {
      readonly status: "stopped"
      readonly problem: VoiceProblem | null
    }
  | {
      readonly status: "unresponsive"
      readonly problem: VoiceCommandFailure | null
    }

/** voice lifecycle state and actions composed into the application store. */
export type VoiceRuntimeSlice = {
  /** Current voice lifecycle state and problem. */
  readonly voiceServerInfo: VoiceServerInfo
  /**
   * Starts voice unless the desktop owns a running one, and waits until it
   * answers its health route, exits, or the readiness timeout passes.
   *
   * @returns Resolves after `running`, `unresponsive`, or `stopped` is
   * published, or after a newer transition superseded the start; never
   * rejects. A failed start publishes `start-failed` with `stopped`, or with
   * `unresponsive` while voice still runs or its status cannot be read.
   */
  readonly startVoice: () => Promise<void>
  /**
   * Stops the owned voice and waits until it exited, up to five seconds.
   *
   * @returns Resolves after `stopped` or, when the stop failed while voice
   * still runs, `unresponsive` is published; never rejects. A kill or a
   * failure is published as the problem.
   */
  readonly stopVoice: () => Promise<void>
}

/** Published while a stop waits for voice. */
const STOPPING_VOICE: VoiceServerInfo = Object.freeze({
  status: "stopping",
  problem: null
})

/** Published for a voice that stopped without a problem. */
const STOPPED_VOICE: VoiceServerInfo = Object.freeze({
  status: "stopped",
  problem: null
})

/** Published for a voice that answers its health route. */
const RUNNING_VOICE: VoiceServerInfo = Object.freeze({
  status: "running",
  problem: null
})

/** Published for a voice that runs without answering its health route. */
const UNRESPONSIVE_VOICE: VoiceServerInfo = Object.freeze({
  status: "unresponsive",
  problem: null
})

/** Problem of a voice killed after the stop timeout. */
const KILLED_VOICE_PROBLEM: VoiceProblem = Object.freeze({ kind: "killed" })

/** Published for a voice killed after the stop timeout. */
const KILLED_VOICE: VoiceServerInfo = Object.freeze({
  status: "stopped",
  problem: KILLED_VOICE_PROBLEM
})

/** State published for each readiness outcome of a start. */
const VOICE_SERVER_INFO_BY_READINESS = Object.freeze({
  ready: RUNNING_VOICE,
  unresponsive: UNRESPONSIVE_VOICE,
  exited: STOPPED_VOICE
} satisfies Readonly<Record<VoiceReadiness, VoiceServerInfo>>)

/**
 * Formats the reason a Tauri voice command rejected with, for the card's
 * problem line.
 *
 * @param rejection - Value the command rejected with: the host's error
 * string, or an error of the IPC layer.
 * @returns The non-empty reason, or a fallback sentence when it has none.
 */
function formatVoiceCommandRejection(rejection: unknown): string {
  if (typeof rejection === "string" && rejection !== "") return rejection
  if (rejection instanceof Error && rejection.message !== "") {
    return rejection.message
  }
  return "the host gave no reason"
}

/**
 * Gets the status to show for the owned voice after a failed start or stop.
 *
 * @returns `unresponsive` while its process is alive, running or still
 * stopping, or when its status cannot be read, so Stop stays offered and
 * joins a stop in progress; `stopped` once the host owns no running voice.
 */
async function getVoiceServerStatusAfterFailure(): Promise<
  "unresponsive" | "stopped"
> {
  try {
    const { status } = await getVoiceStatus()
    return status === "stopped" ? "stopped" : "unresponsive"
  } catch {
    return "unresponsive"
  }
}

/**
 * Registers voice lifecycle state and actions with one Zustand owner.
 *
 * @param set - Framework setter for atomic state updates.
 * @param get - Framework reader for the current state.
 * @returns The initial stopped state and its actions.
 * @remarks The Tauri host owns the voice process; this slice owns what the
 * renderer shows about it. A start publishes its outcome only while the
 * `starting` state it published is still current, so a stop or a newer start
 * that took over wins. Neither action rejects: the Runtime pane shows a
 * failure as the problem.
 */
export function createVoiceRuntimeSlice(
  set: StoreApi<VoiceRuntimeSlice>["setState"],
  get: StoreApi<VoiceRuntimeSlice>["getState"]
): VoiceRuntimeSlice {
  /**
   * Publishes `info` unless a newer transition replaced the start.
   *
   * @param starting - State the start published when it began; it is never
   * shared with another start, so any later transition replaces it.
   * @param info - State the start settled on.
   */
  function updateStartedVoiceServerInfo(
    starting: VoiceServerInfo,
    info: VoiceServerInfo
  ): void {
    if (get().voiceServerInfo !== starting) return
    set({ voiceServerInfo: info })
  }

  /** Implements {@link VoiceRuntimeSlice.startVoice}. */
  async function startVoice(): Promise<void> {
    const starting: VoiceServerInfo = Object.freeze({
      status: "starting",
      problem: null
    })
    set({ voiceServerInfo: starting })
    try {
      const isProcessRunning =
        (await getVoiceStatus()).status === "running" ||
        (await startVoiceProcess()).status === "running"
      const readiness = isProcessRunning ? await getVoiceReadiness() : "exited"
      updateStartedVoiceServerInfo(
        starting,
        VOICE_SERVER_INFO_BY_READINESS[readiness]
      )
    } catch (error) {
      const problem: VoiceCommandFailure = {
        kind: "start-failed",
        message: formatVoiceCommandRejection(error)
      }
      const status = await getVoiceServerStatusAfterFailure()
      const info: VoiceServerInfo = { status, problem }
      updateStartedVoiceServerInfo(starting, info)
    }
  }

  /** Implements {@link VoiceRuntimeSlice.stopVoice}. */
  async function stopVoice(): Promise<void> {
    try {
      if ((await getVoiceStatus()).status === "stopped") {
        set({ voiceServerInfo: STOPPED_VOICE })
        return
      }
      set({ voiceServerInfo: STOPPING_VOICE })
      const outcome = await stopVoiceProcess()
      set({
        voiceServerInfo:
          outcome.status === "killed" ? KILLED_VOICE : STOPPED_VOICE
      })
    } catch (error) {
      const problem: VoiceCommandFailure = {
        kind: "stop-failed",
        message: formatVoiceCommandRejection(error)
      }
      const status = await getVoiceServerStatusAfterFailure()
      const voiceServerInfo: VoiceServerInfo = { status, problem }
      set({ voiceServerInfo })
    }
  }

  return { voiceServerInfo: STOPPED_VOICE, startVoice, stopVoice }
}
