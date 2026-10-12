import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { onTestFinished } from "vitest"

/**
 * Creates the path of a settings file in a new temporary directory, removed
 * with everything in it when the current test finishes; no file exists there
 * yet.
 *
 * @returns Absolute path of `settings.json` in the directory.
 */
export async function createSettingsFilePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "lys-settings-"))
  onTestFinished(async () => {
    await rm(directory, { recursive: true, force: true })
  })
  return join(directory, "settings.json")
}

/**
 * Writes a settings file in a new temporary directory, removed when the
 * current test finishes.
 *
 * @param contents - Exact text or bytes of the file.
 * @returns Absolute path of the file.
 */
export async function writeSettingsFile(
  contents: string | Uint8Array
): Promise<string> {
  const path = await createSettingsFilePath()
  await writeFile(path, contents)
  return path
}
