// Tauri commands related to backend.
import { invoke } from "@tauri-apps/api/core"

/** Serialized status returned by the Tauri backend-process commands. */
export type BackendProcessStatus = {
  /**
   * OS process identifier when the backend is running. Rust currently
   * serializes the stopped `Option<u32>` as `null`, while this renderer type
   * models absence as an omitted optional property.
   */
  pid?: number
  /** Whether the managed backend process is currently running. */
  running: boolean
}

/**
 * Requests that the Tauri process owner start the local backend.
 *
 * @returns A promise resolving to the process status after the command completes.
 * @throws The Tauri invoke rejection when the process cannot be inspected or spawned.
 */
export async function startBackend() {
  return await invoke<BackendProcessStatus>("start_backend")
}

/**
 * Requests that the Tauri process owner terminate the local backend process group.
 *
 * @returns A promise resolving to the process status after termination completes.
 * @throws The Tauri invoke rejection when process locking, termination, or waiting fails.
 */
export async function stopBackend() {
  return await invoke<BackendProcessStatus>("stop_backend")
}

/**
 * Reads the current local backend process status from Tauri.
 *
 * @returns A promise resolving to the process status at invocation time.
 * @throws The Tauri invoke rejection when the process state cannot be inspected.
 */
export async function getBackendStatus() {
  return await invoke<BackendProcessStatus>("get_backend_status")
}
