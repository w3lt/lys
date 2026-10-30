import { MAXIMUM_SETTINGS_FILE_BYTES } from "@lys/share"
import { mkdir } from "node:fs/promises"
import { describe, expect, it } from "vitest"
import { readJustRunToolNames } from "../../../../src/infrastructure/settings/justRunToolsFile"
import {
  createSettingsFilePath,
  writeSettingsFile
} from "../../support/settingsFile"

/**
 * Builds settings file text holding every group the desktop writes.
 *
 * @param justRun - Value of `tools.justRun`.
 * @returns The JSON text.
 */
function buildSettingsText(justRun: unknown): string {
  return JSON.stringify({
    runtime: { autoStartBackend: true, defaultModel: null },
    generation: { temperature: 0.7, replyCeiling: 2048 },
    secrets: { tavilyApiKey: "tvly-synthetic-0123456789" },
    tools: { justRun },
    futureGroup: { anything: [1, 2, 3] }
  })
}

describe("readJustRunToolNames", () => {
  it("reads the saved names, ignoring every other group", async () => {
    const path = await writeSettingsFile(
      buildSettingsText(["read_page", "find_files"])
    )

    const read = await readJustRunToolNames(path)

    expect(read).toEqual({
      status: "read",
      toolNames: new Set(["read_page", "find_files"])
    })
    expect(Object.isFrozen(read)).toBe(true)
  })

  it("ignores a field of the tools group it does not know", async () => {
    const path = await writeSettingsFile(
      '{ "tools": { "justRun": ["read_page"], "switches": { "read_page": true } } }'
    )

    expect(await readJustRunToolNames(path)).toEqual({
      status: "read",
      toolNames: new Set(["read_page"])
    })
  })

  it.each([
    ["no tools group", "{}"],
    ["an empty tools group", '{ "tools": {} }'],
    ["an empty list", '{ "tools": { "justRun": [] } }']
  ])("reads %s as no tool on Just run", async (_label, text) => {
    const path = await writeSettingsFile(text)

    expect(await readJustRunToolNames(path)).toEqual({
      status: "read",
      toolNames: new Set()
    })
  })

  it("reads a missing settings file as no tool on Just run", async () => {
    const path = await createSettingsFilePath()

    expect(await readJustRunToolNames(path)).toEqual({
      status: "read",
      toolNames: new Set()
    })
  })

  it("accepts a name of exactly 64 characters", async () => {
    const toolName = "t".repeat(64)
    const path = await writeSettingsFile(buildSettingsText([toolName]))

    expect(await readJustRunToolNames(path)).toEqual({
      status: "read",
      toolNames: new Set([toolName])
    })
  })

  it.each([
    ["a null tools group", '{ "tools": null }'],
    ["a null list", '{ "tools": { "justRun": null } }'],
    ["a list that is text", '{ "tools": { "justRun": "read_page" } }'],
    ["a name with a space", buildSettingsText(["read page"])],
    ["a name longer than 64 characters", buildSettingsText(["t".repeat(65)])],
    ["an empty name", buildSettingsText([""])],
    ["a name that is a number", buildSettingsText([42])],
    ["text that is not JSON", '{ "tools": { "justRun": ["read_page"] '],
    ["a JSON array", "[]"]
  ])(
    "reports %s as unreadable, with nothing from the file",
    async (_label, text) => {
      const path = await writeSettingsFile(text)

      const read = await readJustRunToolNames(path)

      expect(read).toEqual({ status: "unreadable" })
      expect(JSON.stringify(read)).not.toContain("tvly")
    }
  )

  it("reports bytes that are not UTF-8 as unreadable", async () => {
    const path = await writeSettingsFile(
      Uint8Array.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d])
    )

    expect(await readJustRunToolNames(path)).toEqual({ status: "unreadable" })
  })

  it("reports a file one byte over the size limit as unreadable", async () => {
    const text = buildSettingsText(["read_page"])
    const path = await writeSettingsFile(
      text.padEnd(MAXIMUM_SETTINGS_FILE_BYTES + 1, " ")
    )

    expect(await readJustRunToolNames(path)).toEqual({ status: "unreadable" })
  })

  it("reports a directory at the settings path as unreadable", async () => {
    const path = await createSettingsFilePath()
    await mkdir(path)

    expect(await readJustRunToolNames(path)).toEqual({ status: "unreadable" })
  })
})
