// Tauri commands related to voice, Lys's speech server.
import { invoke } from "@tauri-apps/api/core"

/**
 * Lifecycle stage of the voice process the desktop owns, as the Tauri voice
 * commands report it.
 *
 * @remarks `stopped`: no voice is owned, or the owned one exited. `running`:
 * the owned voice has not exited and no stop has taken it. `stopping`: a stop
 * sent it `SIGTERM` and waits for it to exit.
 */
export type VoiceProcessStatus =
  | { readonly status: "stopped" }
  | {
      readonly status: "running"
      /** Operating-system process identifier. */
      readonly pid: number
    }
  | {
      readonly status: "stopping"
      /** Operating-system process identifier. */
      readonly pid: number
    }

/**
 * How a stop ended voice: `stopped` when it exited within the stop timeout or
 * nothing ran, `killed` when it was killed after the timeout.
 */
export type VoiceStopOutcome =
  { readonly status: "stopped" } | { readonly status: "killed" }

/**
 * Whether voice answered its health route with `200 OK` within about one
 * second: `ready` means its models are loaded and it can speak.
 */
export type VoiceHealth = "ready" | "not-ready"

/**
 * Requests that the Tauri process owner start voice unless it owns a running
 * one.
 *
 * @returns A promise resolving to the process status once voice is spawned or
 * found running; voice answers its health route only later, after its models
 * are loaded.
 * @throws The Tauri invoke rejection while a stop is still waiting for the
 * previous voice, or when the development voice directory cannot be resolved or
 * voice cannot be inspected or spawned.
 */
export async function startVoice(): Promise<VoiceProcessStatus> {
  return await invoke<VoiceProcessStatus>("start_voice")
}

/**
 * Requests that the Tauri process owner stop voice and waits until it exited.
 *
 * @returns A promise resolving to how voice ended, after up to five seconds; a
 * stop already in progress is joined.
 * @throws The Tauri invoke rejection when voice cannot be inspected,
 * signalled, or waited for, or when the host's blocking stop task ends
 * unexpectedly.
 */
export async function stopVoice(): Promise<VoiceStopOutcome> {
  return await invoke<VoiceStopOutcome>("stop_voice")
}

/**
 * Reads the lifecycle stage of the voice process the desktop owns.
 *
 * @returns A promise resolving to the process status at invocation time.
 * @throws The Tauri invoke rejection when the process cannot be inspected.
 */
export async function getVoiceStatus(): Promise<VoiceProcessStatus> {
  return await invoke<VoiceProcessStatus>("get_voice_status")
}

/**
 * Asks voice's health route, through the Tauri host, whether voice can speak.
 *
 * @returns A promise resolving within about one second to voice's health; it
 * asks whatever listens on voice's port, also a voice the desktop does not
 * own.
 * @throws The Tauri invoke rejection when the host's check ends unexpectedly.
 */
export async function getVoiceHealth(): Promise<VoiceHealth> {
  return await invoke<VoiceHealth>("get_voice_health")
}
