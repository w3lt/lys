import type { LysSettings } from "@/lib/store/settings"
import { invoke } from "@tauri-apps/api/core"

/**
 * Loads desktop settings from the Tauri-persisted settings file.
 *
 * @returns A promise resolving to the Rust response as the incomplete renderer
 * projection; Rust-created defaults and extra persisted fields are not mapped.
 * @throws The Tauri invoke rejection when the settings path cannot be read or parsed.
 */
export async function loadSettings() {
  return await invoke<LysSettings>("load_settings")
}

/**
 * Sends desktop settings to the Tauri settings command.
 *
 * @param settings - Complete settings value owned by the desktop store.
 * @returns A promise resolving when Tauri accepts the command; the current
 * argument-shape mismatch rejects before Rust reaches file writing.
 * @throws The Tauri invoke rejection for command deserialization, serialization,
 * directory creation, or file-writing failures.
 * @remarks The adapter currently passes `settings` as the invoke argument
 * object, while Rust expects a named `newSettings` argument. It therefore does
 * not currently establish persistence until that boundary is corrected.
 */
export async function saveSettings(settings: LysSettings) {
  await invoke("save_settings", settings)
}
