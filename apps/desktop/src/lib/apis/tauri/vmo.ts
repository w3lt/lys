// Tauri commands related to vmo, Lys's page reader.
import { invoke } from "@tauri-apps/api/core"

/**
 * Lifecycle stage of the vmo process the desktop owns, as the Tauri vmo
 * commands report it.
 *
 * @remarks `stopped`: no vmo is owned, or the owned one exited. `running`:
 * the owned vmo has not exited and no stop has taken it. `stopping`: a stop
 * sent it `SIGTERM` and waits for it to delete its VMs and exit.
 */
export type VmoProcessStatus =
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
 * How a stop ended vmo: `stopped` when it exited within the stop timeout or
 * nothing ran, `killed` when it was killed after the timeout and may have
 * left VMs running.
 */
export type VmoStopOutcome =
  { readonly status: "stopped" } | { readonly status: "killed" }

/**
 * Whether vmo answered its health route with `200 OK` within about one
 * second: `ready` means it can read pages.
 */
export type VmoHealth = "ready" | "not-ready"

/**
 * Requests that the Tauri process owner start vmo unless it owns a running
 * one.
 *
 * @returns A promise resolving to the process status once vmo is spawned or
 * found running; vmo answers its health route only later.
 * @throws The Tauri invoke rejection while a stop is still waiting for the
 * previous vmo, or when the development vmo directory cannot be resolved or
 * vmo cannot be inspected or spawned.
 */
export async function startVmo(): Promise<VmoProcessStatus> {
  return await invoke<VmoProcessStatus>("start_vmo")
}

/**
 * Requests that the Tauri process owner stop vmo and waits until it exited.
 *
 * @returns A promise resolving to how vmo ended, after up to one minute
 * while vmo deletes its VMs; a stop already in progress is joined.
 * @throws The Tauri invoke rejection when vmo cannot be inspected,
 * signalled, or waited for, or when the host's blocking stop task ends
 * unexpectedly.
 */
export async function stopVmo(): Promise<VmoStopOutcome> {
  return await invoke<VmoStopOutcome>("stop_vmo")
}

/**
 * Reads the lifecycle stage of the vmo process the desktop owns.
 *
 * @returns A promise resolving to the process status at invocation time.
 * @throws The Tauri invoke rejection when the process cannot be inspected.
 */
export async function getVmoStatus(): Promise<VmoProcessStatus> {
  return await invoke<VmoProcessStatus>("get_vmo_status")
}

/**
 * Asks vmo's health route, through the Tauri host, whether vmo can read
 * pages.
 *
 * @returns A promise resolving within about one second to vmo's health; it
 * asks whatever listens on vmo's port, also a vmo the desktop does not own.
 * @throws The Tauri invoke rejection when the host's check ends unexpectedly.
 */
export async function getVmoHealth(): Promise<VmoHealth> {
  return await invoke<VmoHealth>("get_vmo_health")
}
