import { approvedFolderPathSchema } from "@lys/share"
import * as z from "zod"
import { readSettingsFileText } from "./settingsFile"

/**
 * What reading the folders the person lets tools use from the settings file
 * found.
 *
 * @remarks `read`: the saved paths, each passing the shared approved folder
 * path rule; empty when there is no file, no `tools` group, or no
 * `approvedFolders` list, which are the declared forms of "no folder
 * listed". `unreadable`: the file cannot be read, is larger than the limit
 * {@link readSettingsFileText} applies, is not UTF-8, is not a JSON object,
 * or its `tools` group or `approvedFolders` list is `null` or holds anything
 * but valid paths. A read or decode failure is never reported as an empty
 * list.
 */
export type ApprovedFoldersRead =
  | Readonly<{
      /** The saved folders were read. */
      status: "read"
      /** Paths of the folders, as saved; owned by the caller. */
      folderPaths: readonly string[]
    }>
  | Readonly<{
      /** The file could not be read as a settings document. */
      status: "unreadable"
    }>

/**
 * Validates the part of the settings document this reader uses: the
 * optional `tools` group, keeping only its optional `approvedFolders` list.
 *
 * @remarks The desktop host owns and validates the whole document. Every
 * other group and field is dropped unread, so a group or field this reader
 * does not know never makes the list unreadable.
 */
const settingsApprovedFoldersSchema = z.object({
  tools: z
    .object({ approvedFolders: z.array(approvedFolderPathSchema).optional() })
    .optional()
})

/** The part of the settings document this reader uses. */
type SettingsApprovedFolders = z.infer<typeof settingsApprovedFoldersSchema>

/** Read result when the file cannot be read as a settings document. */
const UNREADABLE_SETTINGS: ApprovedFoldersRead = Object.freeze({
  status: "unreadable"
})

/** Paths read when no folder is listed. */
const NO_FOLDER_PATHS: readonly string[] = Object.freeze([])

/**
 * Reads the folders the person lets tools use from the desktop's settings
 * file.
 *
 * @param settingsFilePath - Absolute path of `settings.json`.
 * @returns What the file holds, as {@link ApprovedFoldersRead} describes.
 * Each call reads the file again, so a list the desktop saved applies to
 * the next read.
 * @throws Only when closing the opened file fails.
 * @remarks Never writes. Parse failures are dropped, because JSON parse
 * messages quote the text, which can hold the saved secrets.
 */
export async function readApprovedFolders(
  settingsFilePath: string
): Promise<ApprovedFoldersRead> {
  const file = await readSettingsFileText(settingsFilePath)
  switch (file.status) {
    case "missing":
      return buildApprovedFoldersRead(NO_FOLDER_PATHS)
    case "unreadable":
      return UNREADABLE_SETTINGS
    case "read":
      return parseApprovedFolders(file.text)
  }
}

/**
 * Parses the saved folders out of settings file text.
 *
 * @param text - Text of the settings file.
 * @returns `read` or `unreadable` as {@link ApprovedFoldersRead} describes.
 */
function parseApprovedFolders(text: string): ApprovedFoldersRead {
  const document = parseSettingsApprovedFolders(text)
  if (document === undefined) return UNREADABLE_SETTINGS
  return buildApprovedFoldersRead(
    document.tools?.approvedFolders ?? NO_FOLDER_PATHS
  )
}

/**
 * Builds the read result of the saved folders.
 *
 * @param folderPaths - Validated paths.
 * @returns A frozen `read` result holding a new frozen list.
 */
function buildApprovedFoldersRead(
  folderPaths: readonly string[]
): ApprovedFoldersRead {
  return Object.freeze({
    status: "read",
    folderPaths: Object.freeze([...folderPaths])
  })
}

/**
 * Parses settings file text into the part this reader uses.
 *
 * @param text - Text of the settings file.
 * @returns The part, or undefined when the text is not JSON or the part is
 * invalid.
 * @remarks A parse failure is dropped, never kept or logged, because its
 * message can quote the text.
 */
function parseSettingsApprovedFolders(
  text: string
): SettingsApprovedFolders | undefined {
  try {
    const document: unknown = JSON.parse(text)
    const parsed = settingsApprovedFoldersSchema.safeParse(document)
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}
