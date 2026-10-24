import type { McpServerSettings, McpSettings } from "@lys/share"
import type { StoreApi } from "zustand"

import type { LysSettings } from "./settings"

/** Lifecycle of the latest save of the MCP servers. */
export type McpSettingsSaveState =
  | { readonly status: "idle" }
  | { readonly status: "saving" }
  | { readonly status: "saved" }
  | {
      readonly status: "failed"
      /**
       * Caller-safe reason, without a command, URL, environment value,
       * header, or native path.
       */
      readonly error: string
    }

/**
 * Outcome of one save request: `saved` once the file holds the servers,
 * `failed` when the save failed, and `busy` when another save of the servers
 * was still running, so nothing was saved.
 */
export type McpSettingsSaveOutcome = "saved" | "failed" | "busy"

/** MCP server settings state and its command. */
export type McpSettingsSlice = {
  /** Latest save outcome, retained across pane unmounts. */
  readonly mcpSettingsSave: McpSettingsSaveState
  /**
   * Saves the whole list of MCP servers, replacing the saved one.
   * @param servers - Servers in list order, each one validated by the shared
   * server schema, each name once, at most the shared server count.
   * @returns `saved` after the settings file holds the new list and the
   * store does too, `failed` when the save failed, or `busy` without saving
   * while another save of the servers runs. It never rejects.
   * @remarks Saving does not apply the servers: the backend reads the group
   * when it starts or when the desktop asks it to apply the group again.
   */
  readonly saveMcpServers: (
    servers: readonly McpServerSettings[]
  ) => Promise<McpSettingsSaveOutcome>
}

/** Narrow application state borrowed by the MCP settings slice. */
type McpSettingsStore = McpSettingsSlice & {
  /** Current settings owned by the application store. */
  readonly settings: LysSettings
}

/** Capabilities the MCP settings slice uses. */
export type McpSettingsDependencies = {
  /** Saves the MCP group, serialized with the other group saves. */
  readonly saveMcpSettings: (mcp: McpSettings) => Promise<void>
}

/** Save state before any save. */
const IDLE_SAVE: McpSettingsSaveState = Object.freeze({ status: "idle" })

/** Save state while a save runs. */
const SAVING: McpSettingsSaveState = Object.freeze({ status: "saving" })

/** Save state after a save. */
const SAVED: McpSettingsSaveState = Object.freeze({ status: "saved" })

/** Save state after a failed save. */
const SAVE_FAILED: McpSettingsSaveState = Object.freeze({
  status: "failed",
  error: "Lys couldn't write the MCP servers to its settings file."
})

/**
 * Creates the application-owned MCP settings command and initial state.
 * @param set - Owning store's atomic state updater.
 * @param get - Reads the slice's state.
 * @param dependencies - Group save capability.
 * @returns The slice.
 * @remarks The store's servers change only after the file holds the new
 * list, because the backend reads the file: the MCP pane never shows a
 * server as saved that the backend would not apply. The desktop host checks
 * the group with the shared rules before it writes, so a list it refuses
 * fails the save and leaves the file as it was. Native writes are not
 * cancellable; leaving the pane cancels nothing.
 */
export function createMcpSettingsSlice(
  set: StoreApi<McpSettingsStore>["setState"],
  get: StoreApi<McpSettingsStore>["getState"],
  dependencies: McpSettingsDependencies
): McpSettingsSlice {
  /**
   * Implements {@link McpSettingsSlice.saveMcpServers}.
   * @param servers - Servers to save.
   * @returns The save outcome.
   */
  async function saveMcpServers(
    servers: readonly McpServerSettings[]
  ): Promise<McpSettingsSaveOutcome> {
    if (get().mcpSettingsSave.status === "saving") return "busy"
    const mcp: McpSettings = Object.freeze({
      servers: Object.freeze([...servers])
    })
    set({ mcpSettingsSave: SAVING })
    try {
      await dependencies.saveMcpSettings(mcp)
    } catch {
      set({ mcpSettingsSave: SAVE_FAILED })
      return "failed"
    }
    set((state) => ({
      settings: { ...state.settings, mcp },
      mcpSettingsSave: SAVED
    }))
    return "saved"
  }

  return { mcpSettingsSave: IDLE_SAVE, saveMcpServers }
}
