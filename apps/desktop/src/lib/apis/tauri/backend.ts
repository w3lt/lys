// Tauri commands related to backend
import { invoke } from '@tauri-apps/api/core'

export function startBackend() {
  invoke('start_backend')
}

export function stopBackend() {
  invoke('stop_backend')
}