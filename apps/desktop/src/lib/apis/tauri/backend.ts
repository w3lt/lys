// Tauri commands related to backend
import { invoke } from "@tauri-apps/api/core"

export type BackendProcessStatus = {
  pid?: number
  running: boolean
}

export async function startBackend() {
  return await invoke<BackendProcessStatus>("start_backend")
}

export async function stopBackend() {
  return await invoke<BackendProcessStatus>("stop_backend")
}

export async function getBackendStatus() {
  return await invoke<BackendProcessStatus>("get_backend_status")
}
