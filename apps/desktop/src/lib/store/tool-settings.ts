import type { StoreApi } from "zustand"

import type { LysSettings, ToolSettings } from "./settings"
import {
  saveLatestSettingsGroup,
  type SettingsGroupSaves
} from "./settings-group-saves"

/** Every approval the Tools pane offers for a tool, in display order. */
export const TOOL_APPROVALS = Object.freeze(["ask", "run"] as const)

/**
 * When a tool runs once the model asks for it: `ask` waits for the person to
 * allow each call, and `run` runs it at once.
 *
 * @remarks A tool asks unless its name is saved as Just run in the `tools`
 * settings group. The tool-call gate applies the approval when each call
 * arrives, for the desktop's tools and the backend's alike.
 */
export type ToolApproval = (typeof TOOL_APPROVALS)[number]

/**
 * Application-owned lifecycle of the latest tool-choice save; a choice stays
 * applied for the session when its save fails.
 */
export type ToolSettingsSaveState =
  | { readonly status: "idle" }
  | { readonly status: "saving" }
  | { readonly status: "saved" }
  | { readonly status: "failed" }

/** Tool approval commands and the autosave of the tools group. */
export type ToolSettingsSlice = {
  /** Latest save outcome, retained across settings-pane unmounts. */
  readonly toolSettingsSave: ToolSettingsSaveState
  /**
   * Replaces when one tool runs, at once, and saves the tools group.
   *
   * @param toolName - Name of a listed tool.
   * @param approval - When the tool runs once the model asks for it.
   * @remarks The approval applies to every call that arrives afterwards. A
   * tool that already has the approval changes and saves nothing.
   * `toolSettingsSave` reports the save; a failed save leaves the approval
   * applied for this session only.
   */
  readonly updateToolApproval: (
    toolName: string,
    approval: ToolApproval
  ) => void
  /**
   * Persists the current tool choices, preserving the other groups on disk.
   * @returns Resolves after the latest change is saved or fails; it never
   * rejects. Calls during a save return immediately; the active save also
   * saves any newer change.
   */
  readonly saveToolSettings: () => Promise<void>
}

/** Narrow application state borrowed by the tool-settings slice. */
type ToolSettingsStore = ToolSettingsSlice & {
  /** Current settings owned by the application store. */
  readonly settings: LysSettings
}

/**
 * Gets when one tool runs once the model asks for it.
 *
 * @param justRunToolNames - Names of the tools on Just run.
 * @param toolName - Name of the tool.
 * @returns `run` when the name is on Just run, and `ask` otherwise, also
 * before the settings file has loaded.
 */
export function getToolApproval(
  justRunToolNames: ReadonlySet<string>,
  toolName: string
): ToolApproval {
  return justRunToolNames.has(toolName) ? "run" : "ask"
}

/**
 * Compares tool choices by value.
 *
 * @param first - One tool-choice value.
 * @param second - The other tool-choice value.
 * @returns Whether both put the same tools on Just run, in any order.
 */
export function isToolSettingsEqual(
  first: ToolSettings,
  second: ToolSettings
): boolean {
  return (
    first.justRunToolNames.size === second.justRunToolNames.size &&
    [...first.justRunToolNames].every((toolName) =>
      second.justRunToolNames.has(toolName)
    )
  )
}

/**
 * Builds the tool choices with one tool's approval replaced.
 *
 * @param tools - Current choices, left unchanged.
 * @param toolName - Name of the tool whose approval is replaced.
 * @param approval - New approval of the tool.
 * @returns A new frozen value whose set holds the tool's name only on Just
 * run, keeping every other name, also names Lys does not list.
 */
function buildToolSettings(
  tools: ToolSettings,
  toolName: string,
  approval: ToolApproval
): ToolSettings {
  const justRunToolNames = new Set(tools.justRunToolNames)
  switch (approval) {
    case "run":
      justRunToolNames.add(toolName)
      break
    case "ask":
      justRunToolNames.delete(toolName)
      break
  }

  return Object.freeze({ justRunToolNames })
}

/**
 * Creates the application-owned tool approval commands and initial state.
 * @param set - Owning store's atomic state updater.
 * @param get - Reads the current settings and save lifecycle.
 * @param dependencies - Save operation that the application serializes with
 * the other settings-group saves.
 * @returns A slice that applies each approval at once and saves the tools
 * group, coalescing pending changes to the latest value.
 * @remarks Native writes are not cancellable. Pane unmount does not cancel
 * work; completion never overwrites a change made after the save began. A
 * newer change is saved after the active write settles, including after
 * failure. Otherwise a failure stops saving until another change or an
 * explicit retry; `toolSettingsSave` exposes that failure without native
 * paths or raw error payloads.
 */
export function createToolSettingsSlice(
  set: StoreApi<ToolSettingsStore>["setState"],
  get: StoreApi<ToolSettingsStore>["getState"],
  dependencies: Pick<SettingsGroupSaves, "saveToolSettings">
): ToolSettingsSlice {
  /**
   * Saves successive current snapshots until the latest change is persisted
   * or fails.
   * @returns Resolves after settlement; an active save owns overlapping
   * requests.
   */
  async function saveToolSettings(): Promise<void> {
    if (get().toolSettingsSave.status === "saving") return
    const activeSave: ToolSettingsSaveState = { status: "saving" }
    set({ toolSettingsSave: activeSave })
    const status = await saveLatestSettingsGroup({
      getCurrent: () => get().settings.tools,
      isEqual: isToolSettingsEqual,
      save: dependencies.saveToolSettings
    })
    const settledSave: ToolSettingsSaveState = { status }
    set({ toolSettingsSave: settledSave })
  }

  /**
   * Implements {@link ToolSettingsSlice.updateToolApproval}.
   * @param toolName - Name of a listed tool.
   * @param approval - When the tool runs once the model asks for it.
   */
  function updateToolApproval(toolName: string, approval: ToolApproval): void {
    const { tools } = get().settings
    if (getToolApproval(tools.justRunToolNames, toolName) === approval) return

    const nextTools = buildToolSettings(tools, toolName, approval)
    set((state) => ({ settings: { ...state.settings, tools: nextTools } }))
    // Saving never rejects; it records its outcome in toolSettingsSave.
    void saveToolSettings()
  }

  const idleSave: ToolSettingsSaveState = { status: "idle" }
  return {
    toolSettingsSave: idleSave,
    updateToolApproval,
    saveToolSettings
  }
}
