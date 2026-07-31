import { LysSettings } from "@/lib/store/settings"
import { invoke } from "@tauri-apps/api/core"

export async function loadSettings() {
  return await invoke<LysSettings>("load_settings")
}

export async function saveSettings(settings: LysSettings) {
  await invoke("save_settings", settings)
}
