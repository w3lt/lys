import { mkdir } from "node:fs/promises"
import { describe, expect, it } from "vitest"
import {
  MAXIMUM_SETTINGS_FILE_BYTES,
  readTavilyApiKey
} from "../../../../src/infrastructure/settings/tavilyApiKeyFile"
import {
  createSettingsFilePath,
  writeSettingsFile
} from "../../support/settingsFile"

/** Synthetic key in Tavily's format; not a real credential. */
const SYNTHETIC_KEY = "tvly-synthetic-0123456789"

/**
 * Builds settings file text holding every group the desktop writes.
 *
 * @param tavilyApiKey - Value of `secrets.tavilyApiKey`.
 * @returns The JSON text.
 */
function buildSettingsText(tavilyApiKey: unknown): string {
  return JSON.stringify({
    runtime: { autoStartBackend: true, defaultModel: null },
    generation: { temperature: 0.7, replyCeiling: 2048 },
    secrets: { tavilyApiKey },
    futureGroup: { anything: [1, 2, 3] }
  })
}

describe("readTavilyApiKey", () => {
  it("reads a saved key, ignoring every other group and field", async () => {
    const path = await writeSettingsFile(buildSettingsText(SYNTHETIC_KEY))

    const read = await readTavilyApiKey(path)

    expect(read).toEqual({ status: "configured", apiKey: SYNTHETIC_KEY })
    expect(Object.isFrozen(read)).toBe(true)
  })

  it.each([
    ["no secrets group", "{}"],
    ["an empty secrets group", '{ "secrets": {} }'],
    ["a null key", '{ "secrets": { "tavilyApiKey": null } }']
  ])("reads %s as no key", async (_label, text) => {
    const path = await writeSettingsFile(text)

    expect(await readTavilyApiKey(path)).toEqual({ status: "missing" })
  })

  it("reads a missing settings file as no key", async () => {
    const path = await createSettingsFilePath()

    expect(await readTavilyApiKey(path)).toEqual({ status: "missing" })
  })

  it.each([
    ["an empty key", ""],
    ["a key with a trailing space", `${SYNTHETIC_KEY} `],
    ["a key with a line break", `${SYNTHETIC_KEY}\n`],
    ["a key with a non-ASCII character", "tvly-clé"],
    ["a key longer than 256 characters", "k".repeat(257)],
    ["a number", 42]
  ])("reports %s as an invalid key, never as no key", async (_label, value) => {
    const path = await writeSettingsFile(buildSettingsText(value))

    expect(await readTavilyApiKey(path)).toEqual({ status: "invalid" })
  })

  it("accepts a key of exactly 256 characters", async () => {
    const key = "k".repeat(256)
    const path = await writeSettingsFile(buildSettingsText(key))

    expect(await readTavilyApiKey(path)).toEqual({
      status: "configured",
      apiKey: key
    })
  })

  it.each([
    [
      "text that is not JSON",
      `{ "secrets": { "tavilyApiKey": "${SYNTHETIC_KEY}" `
    ],
    ["a JSON array", "[]"],
    ["a JSON string", '"settings"'],
    ["a null secrets group", '{ "secrets": null }'],
    ["a secrets group that is text", '{ "secrets": "hidden" }']
  ])(
    "reports %s as unreadable, with nothing from the file",
    async (_label, text) => {
      const path = await writeSettingsFile(text)

      const read = await readTavilyApiKey(path)

      expect(read).toEqual({ status: "unreadable" })
      expect(JSON.stringify(read)).not.toContain("tvly")
    }
  )

  it("reports bytes that are not UTF-8 as unreadable", async () => {
    const path = await writeSettingsFile(
      Uint8Array.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d])
    )

    expect(await readTavilyApiKey(path)).toEqual({ status: "unreadable" })
  })

  it("reads a file of exactly the size limit", async () => {
    const text = buildSettingsText(SYNTHETIC_KEY)
    const path = await writeSettingsFile(
      text.padEnd(MAXIMUM_SETTINGS_FILE_BYTES, " ")
    )

    expect(await readTavilyApiKey(path)).toEqual({
      status: "configured",
      apiKey: SYNTHETIC_KEY
    })
  })

  it("reports a file one byte over the size limit as unreadable", async () => {
    const text = buildSettingsText(SYNTHETIC_KEY)
    const path = await writeSettingsFile(
      text.padEnd(MAXIMUM_SETTINGS_FILE_BYTES + 1, " ")
    )

    expect(await readTavilyApiKey(path)).toEqual({ status: "unreadable" })
  })

  it("reports a directory at the settings path as unreadable", async () => {
    const path = await createSettingsFilePath()
    await mkdir(path)

    expect(await readTavilyApiKey(path)).toEqual({ status: "unreadable" })
  })
})
