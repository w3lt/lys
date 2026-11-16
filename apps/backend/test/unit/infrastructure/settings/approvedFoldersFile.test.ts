import { MAXIMUM_APPROVED_FOLDER_PATH_LENGTH } from "@lys/share"
import { mkdir } from "node:fs/promises"
import { describe, expect, it } from "vitest"
import { readApprovedFolders } from "../../../../src/infrastructure/settings/approvedFoldersFile"
import {
  createSettingsFilePath,
  writeSettingsFile
} from "../../support/settingsFile"

/**
 * Builds settings file text holding the groups the desktop writes around
 * the list.
 *
 * @param approvedFolders - Value of `tools.approvedFolders`.
 * @returns The JSON text.
 */
function buildSettingsText(approvedFolders: unknown): string {
  return JSON.stringify({
    secrets: { tavilyApiKey: "tvly-synthetic-0123456789" },
    tools: { justRun: ["read_page"], switches: {}, approvedFolders },
    futureGroup: { anything: [1, 2, 3] }
  })
}

/** Settings texts the reader reports as no folder listed, by label. */
const NO_FOLDER_TEXTS = Object.freeze({
  "no tools group": "{}",
  "a tools group without the list": '{ "tools": { "justRun": [] } }',
  "an empty list": buildSettingsText([])
})

/** Settings texts the reader reports as unreadable, by label. */
const UNREADABLE_TEXTS = Object.freeze({
  "a null tools group": '{ "tools": null }',
  "a null list": buildSettingsText(null),
  "a list that is text": buildSettingsText("/home/ada"),
  "a relative path": buildSettingsText(["work/app"]),
  "a path in the home folder's form": buildSettingsText(["~/work"]),
  "an empty path": buildSettingsText([""]),
  "a path with a line break": buildSettingsText(["/home/ada\n/etc"]),
  "a path with a space at its end": buildSettingsText(["/home/ada "]),
  "a path one character too long": buildSettingsText([
    `/${"a".repeat(MAXIMUM_APPROVED_FOLDER_PATH_LENGTH)}`
  ]),
  "text that is not JSON": '{ "tools": { "approvedFolders": [] '
})

describe("readApprovedFolders", () => {
  it("reads the saved paths as saved, ignoring every other group", async () => {
    const path = await writeSettingsFile(
      buildSettingsText(["/home/ada/My Documents", "/srv/shared/"])
    )

    const read = await readApprovedFolders(path)

    expect(read).toStrictEqual({
      status: "read",
      folderPaths: ["/home/ada/My Documents", "/srv/shared/"]
    })
    expect(Object.isFrozen(read)).toBe(true)
    expect(read.status === "read" && Object.isFrozen(read.folderPaths)).toBe(
      true
    )
  })

  it("accepts a path of exactly the longest length", async () => {
    const folderPath = `/${"a".repeat(MAXIMUM_APPROVED_FOLDER_PATH_LENGTH - 1)}`
    const path = await writeSettingsFile(buildSettingsText([folderPath]))

    expect(await readApprovedFolders(path)).toStrictEqual({
      status: "read",
      folderPaths: [folderPath]
    })
  })

  it.each(Object.entries(NO_FOLDER_TEXTS))(
    "reads %s as no folder listed",
    async (_label, text) => {
      const path = await writeSettingsFile(text)

      expect(await readApprovedFolders(path)).toStrictEqual({
        status: "read",
        folderPaths: []
      })
    }
  )

  it("reads a missing settings file as no folder listed", async () => {
    const path = await createSettingsFilePath()

    expect(await readApprovedFolders(path)).toStrictEqual({
      status: "read",
      folderPaths: []
    })
  })

  it.each(Object.entries(UNREADABLE_TEXTS))(
    "reports %s as unreadable, with nothing from the file",
    async (_label, text) => {
      const path = await writeSettingsFile(text)

      const read = await readApprovedFolders(path)

      expect(read).toStrictEqual({ status: "unreadable" })
      expect(JSON.stringify(read)).not.toContain("tvly")
    }
  )

  it("reports a directory at the settings path as unreadable", async () => {
    const path = await createSettingsFilePath()
    await mkdir(path)

    expect(await readApprovedFolders(path)).toStrictEqual({
      status: "unreadable"
    })
  })
})
