import type { McpSettings } from "@lys/share"

import {
  saveGenerationSettings,
  saveLoadConfigurationSettings,
  saveLocationSettings,
  saveMcpSettings,
  saveRuntimeAutoStartSettings,
  saveSecretsSettings,
  saveToolSettings
} from "@/lib/apis/tauri/settings"

import type {
  GenerationSettings,
  LoadConfigurationSettings,
  LocationSettings,
  RuntimeAutoStartSettings,
  SecretsSettings,
  ToolSettings
} from "./settings"

/**
 * Saves of the persisted settings groups, applied to the settings file one at
 * a time.
 */
export type SettingsGroupSaves = {
  /**
   * Saves the generation group after every save sent earlier has settled.
   *
   * @param generation - Generation controls to persist.
   * @returns Resolves after the settings file is written, and rejects with
   * the native load or save rejection.
   */
  readonly saveGenerationSettings: (
    generation: GenerationSettings
  ) => Promise<void>
  /**
   * Saves the per-model settings of the load configuration group after every
   * save sent earlier has settled.
   *
   * @param loadConfiguration - Load settings whose per-model settings are
   * persisted. The stored default is not written; the file keeps its own.
   * @returns Resolves after the settings file is written, and rejects with
   * the native load or save rejection.
   */
  readonly saveLoadConfigurationSettings: (
    loadConfiguration: LoadConfigurationSettings
  ) => Promise<void>
  /**
   * Saves the secrets group after every save sent earlier has settled.
   *
   * @param secrets - Secrets to persist.
   * @returns Resolves after the settings file is written, and rejects with
   * the native load or save rejection.
   */
  readonly saveSecretsSettings: (secrets: SecretsSettings) => Promise<void>
  /**
   * Saves the tools group after every save sent earlier has settled.
   *
   * @param tools - Tool choices to persist.
   * @returns Resolves after the settings file is written, and rejects with
   * the native load or save rejection.
   */
  readonly saveToolSettings: (tools: ToolSettings) => Promise<void>
  /**
   * Saves the location group after every save sent earlier has settled.
   *
   * @param location - Location to persist.
   * @returns Resolves after the settings file is written, and rejects with
   * the native load or save rejection.
   */
  readonly saveLocationSettings: (location: LocationSettings) => Promise<void>
  /**
   * Saves the MCP group after every save sent earlier has settled.
   *
   * @param mcp - MCP servers to persist.
   * @returns Resolves after the settings file is written, and rejects with
   * the native load or save rejection.
   */
  readonly saveMcpSettings: (mcp: McpSettings) => Promise<void>
  /**
   * Saves the two startup switches of the runtime group after every save
   * sent earlier has settled.
   *
   * @param autoStart - Startup switches to persist. The rest of the runtime
   * group is written as it is on disk.
   * @returns Resolves after the settings file is written, and rejects with
   * the native load or save rejection.
   */
  readonly saveRuntimeAutoStartSettings: (
    autoStart: RuntimeAutoStartSettings
  ) => Promise<void>
}

/** One settings group whose latest value is to be saved. */
export type LatestSettingsGroupSave<TGroup> = {
  /** Reads the group's current value. */
  readonly getCurrent: () => TGroup
  /** Answers whether two values of the group are equal by value. */
  readonly isEqual: (first: TGroup, second: TGroup) => boolean
  /** Persists one value of the group; rejects when it cannot be saved. */
  readonly save: (group: TGroup) => Promise<void>
}

/** Whether the latest value of a settings group was saved. */
export type SettingsGroupSaveOutcome = "saved" | "failed"

/**
 * Creates the owner that applies settings-group saves to the settings file
 * one at a time.
 *
 * @returns Save operations that each start after every save sent earlier
 * through the same owner has settled, in the order they were sent.
 * @remarks Each save reads the whole settings document, replaces the part it
 * owns, and writes the document back. Two overlapping saves would each write
 * back the other's part as it was before, so one of them would be lost;
 * running them in order prevents that for saves sent through one owner. A
 * failed save rejects only its own caller, and later saves still run. Native
 * writes are not cancellable. The application store creates one owner and
 * gives each group's autosave its save operation; an autosave sends its next
 * save only after its previous one settled, so at most one save per group
 * waits.
 */
export function createSettingsGroupSaves(): SettingsGroupSaves {
  let previousSaveSettlement: Promise<void> = Promise.resolve()

  /**
   * Starts a save once every save sent earlier has settled.
   *
   * @param save - Read-modify-write of the settings document.
   * @returns The settlement of that save.
   */
  function saveSettingsGroupInOrder(save: () => Promise<void>): Promise<void> {
    const saveSettlement = previousSaveSettlement.then(save)
    // The caller observes a failure; the next save only waits for settlement.
    previousSaveSettlement = saveSettlement.catch(() => undefined)
    return saveSettlement
  }

  return {
    saveGenerationSettings: (generation) =>
      saveSettingsGroupInOrder(() => saveGenerationSettings(generation)),
    saveLoadConfigurationSettings: (loadConfiguration) =>
      saveSettingsGroupInOrder(() =>
        saveLoadConfigurationSettings(loadConfiguration)
      ),
    saveSecretsSettings: (secrets) =>
      saveSettingsGroupInOrder(() => saveSecretsSettings(secrets)),
    saveToolSettings: (tools) =>
      saveSettingsGroupInOrder(() => saveToolSettings(tools)),
    saveLocationSettings: (location) =>
      saveSettingsGroupInOrder(() => saveLocationSettings(location)),
    saveMcpSettings: (mcp) =>
      saveSettingsGroupInOrder(() => saveMcpSettings(mcp)),
    saveRuntimeAutoStartSettings: (autoStart) =>
      saveSettingsGroupInOrder(() => saveRuntimeAutoStartSettings(autoStart))
  }
}

/**
 * Saves successive current values of one settings group until the latest
 * value is saved or its save fails.
 *
 * @typeParam TGroup - Value of the settings group.
 * @param group - Reader, comparison, and save operation of the group.
 * @returns `saved` once a save completed for a value that is still current,
 * or `failed` once a save failed for a value that is still current.
 * @remarks A value that changed while its save was in flight is saved again,
 * whether that save succeeded or failed, so completion never reports an
 * older value as the latest. Saves are not retried otherwise.
 */
export async function saveLatestSettingsGroup<TGroup>(
  group: LatestSettingsGroupSave<TGroup>
): Promise<SettingsGroupSaveOutcome> {
  while (true) {
    const sampled = group.getCurrent()
    try {
      await group.save(sampled)
    } catch {
      if (!group.isEqual(sampled, group.getCurrent())) continue
      return "failed"
    }
    if (group.isEqual(sampled, group.getCurrent())) return "saved"
  }
}
