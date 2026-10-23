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
 * settings group. The backend's tool approval service reads the saved group
 * when each round of tool calls arrives and decides, for the desktop's tools
 * and the backend's alike, which calls are shown to the person; the desktop
 * only saves the choice.
 */
export type ToolApproval = (typeof TOOL_APPROVALS)[number]

/**
 * Application-owned lifecycle of the latest tool-choice save; a choice whose
 * save fails stays selected in the pane. A switch applies to chat requests
 * at once, saved or not, while approvals keep following the choices last
 * saved.
 */
export type ToolSettingsSaveState =
  | { readonly status: "idle" }
  | { readonly status: "saving" }
  | { readonly status: "saved" }
  | { readonly status: "failed" }

/** Tool approval and switch commands and the autosave of the tools group. */
export type ToolSettingsSlice = {
  /** Latest save outcome, retained across settings-pane unmounts. */
  readonly toolSettingsSave: ToolSettingsSaveState
  /**
   * Replaces when one tool runs, at once, and saves the tools group.
   *
   * @param toolName - Name of a listed tool.
   * @param approval - When the tool runs once the model asks for it.
   * @remarks The pane shows the approval at once; tool calls follow it from
   * the next round of calls after the save completes, because the backend
   * reads the settings file. A tool that already has the approval changes
   * and saves nothing. `toolSettingsSave` reports the save; after a failed
   * save, tool calls keep following the choices last saved.
   */
  readonly updateToolApproval: (
    toolName: string,
    approval: ToolApproval
  ) => void
  /**
   * Switches one tool on or off and saves the tools group.
   *
   * @param toolName - Name of a listed tool.
   * @param isOn - Whether the tool is offered to the model.
   * @remarks The pane and the next chat request follow the switch at once,
   * because the desktop builds each request's offer; the save keeps it for
   * the next launch. A tool whose saved switch already has the value
   * changes and saves nothing. `toolSettingsSave` reports the save; after a
   * failed save, the switch still applies until Lys quits.
   */
  readonly updateToolOn: (toolName: string, isOn: boolean) => void
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
 * @returns Whether both put the same tools on Just run and give the same
 * tools the same switch, in any order.
 */
export function isToolSettingsEqual(
  first: ToolSettings,
  second: ToolSettings
): boolean {
  return (
    first.justRunToolNames.size === second.justRunToolNames.size &&
    [...first.justRunToolNames].every((toolName) =>
      second.justRunToolNames.has(toolName)
    ) &&
    first.switches.size === second.switches.size &&
    [...first.switches].every(
      ([toolName, isOn]) => second.switches.get(toolName) === isOn
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
 * run, keeping every other name, also names Lys does not list, and every
 * switch.
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

  return Object.freeze({ justRunToolNames, switches: tools.switches })
}

/**
 * Builds the tool choices with one tool's switch replaced.
 *
 * @param tools - Current choices, left unchanged.
 * @param toolName - Name of the tool whose switch is replaced.
 * @param isOn - Whether the tool is offered to the model.
 * @returns A new frozen value holding every current approval and switch and
 * the replacement.
 */
function buildToolSwitchSettings(
  tools: ToolSettings,
  toolName: string,
  isOn: boolean
): ToolSettings {
  const switches = new Map(tools.switches)
  switches.set(toolName, isOn)

  return Object.freeze({ justRunToolNames: tools.justRunToolNames, switches })
}

/**
 * Creates the application-owned tool approval and switch commands and
 * initial state.
 * @param set - Owning store's atomic state updater.
 * @param get - Reads the current settings and save lifecycle.
 * @param dependencies - Save operation that the application serializes with
 * the other settings-group saves.
 * @returns A slice that applies each approval and switch at once and saves
 * the tools group, coalescing pending changes to the latest value.
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

    updateToolSettings(buildToolSettings(tools, toolName, approval))
  }

  /**
   * Implements {@link ToolSettingsSlice.updateToolOn}.
   * @param toolName - Name of a listed tool.
   * @param isOn - Whether the tool is offered to the model.
   */
  function updateToolOn(toolName: string, isOn: boolean): void {
    const { tools } = get().settings
    if (tools.switches.get(toolName) === isOn) return

    updateToolSettings(buildToolSwitchSettings(tools, toolName, isOn))
  }

  /**
   * Replaces the tool choices and starts saving them.
   * @param nextTools - Complete replacement choices.
   */
  function updateToolSettings(nextTools: ToolSettings): void {
    set((state) => {
      const settings: LysSettings = { ...state.settings, tools: nextTools }
      return { settings }
    })
    // Saving never rejects; it records its outcome in toolSettingsSave.
    void saveToolSettings()
  }

  const idleSave: ToolSettingsSaveState = { status: "idle" }
  return {
    toolSettingsSave: idleSave,
    updateToolApproval,
    updateToolOn,
    saveToolSettings
  }
}
