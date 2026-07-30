// Tauri commands related to backend
import { invoke } from "@tauri-apps/api/core"

export async function startBackend() {
  await invoke("start_backend")
}

export async function stopBackend() {
  await invoke("stop_backend")
}
