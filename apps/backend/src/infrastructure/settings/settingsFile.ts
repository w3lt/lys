import { open, type FileHandle } from "node:fs/promises"

/**
 * Most bytes of the settings file the backend reads, inclusive; a larger
 * file is unreadable here. The desktop's own settings stay far below it.
 */
export const MAXIMUM_SETTINGS_FILE_BYTES = 1024 * 1024

/**
 * Outcome of reading the settings file's text.
 *
 * @remarks `missing` only when no file exists at the path; every other
 * failure to read the file as text within
 * {@link MAXIMUM_SETTINGS_FILE_BYTES} is `unreadable`.
 */
export type SettingsFileText =
  | Readonly<{
      /** The file was read. */
      status: "read"
      /** Its text, which can hold secrets. */
      text: string
    }>
  | Readonly<{
      /** No file exists at the path. */
      status: "missing"
    }>
  | Readonly<{
      /** The file exists but could not be read as text within the limit. */
      status: "unreadable"
    }>

/** Outcome of opening the settings file. */
type SettingsFileHandle =
  | Readonly<{
      /** The file is open. */
      status: "opened"
      /** Handle the caller closes. */
      handle: FileHandle
    }>
  | Readonly<{
      /** No file exists at the path. */
      status: "missing"
    }>
  | Readonly<{
      /** The file could not be opened for another reason. */
      status: "unreadable"
    }>

/** File outcome when no file exists. */
const MISSING_FILE: SettingsFileText & SettingsFileHandle = Object.freeze({
  status: "missing"
})

/** File outcome when the file cannot be read as text. */
const UNREADABLE_FILE: SettingsFileText & SettingsFileHandle = Object.freeze({
  status: "unreadable"
})

/** Decoder that rejects bytes that are not UTF-8. */
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true })

/**
 * Reads the desktop's settings file as text within the size limit.
 *
 * @param path - Absolute path of `settings.json`.
 * @returns The text, `missing` when no file exists, or `unreadable`. Each
 * call reads the file again.
 * @throws Only when closing the opened file fails.
 * @remarks Never writes. The desktop host replaces the file atomically, so a
 * read sees a whole document.
 */
export async function readSettingsFileText(
  path: string
): Promise<SettingsFileText> {
  const file = await openSettingsFile(path)
  if (file.status !== "opened") return file
  try {
    return await readBoundedText(file.handle)
  } finally {
    await file.handle.close()
  }
}

/**
 * Opens the settings file for reading.
 *
 * @param path - Absolute path of the file.
 * @returns The handle, `missing` when no file exists, or `unreadable` for any
 * other failure.
 */
async function openSettingsFile(path: string): Promise<SettingsFileHandle> {
  try {
    const handle = await open(path, "r")
    return Object.freeze({ status: "opened", handle })
  } catch (error) {
    return isMissingFileError(error) ? MISSING_FILE : UNREADABLE_FILE
  }
}

/**
 * Reads an open file's text within the size limit.
 *
 * @param handle - Open handle; the caller closes it.
 * @returns The text, or `unreadable` for a file over the limit, bytes that
 * are not UTF-8, or a read failure.
 */
async function readBoundedText(handle: FileHandle): Promise<SettingsFileText> {
  try {
    const { size } = await handle.stat()
    if (size > MAXIMUM_SETTINGS_FILE_BYTES) return UNREADABLE_FILE
    const bytes = await handle.readFile()
    if (bytes.byteLength > MAXIMUM_SETTINGS_FILE_BYTES) return UNREADABLE_FILE
    return Object.freeze({ status: "read", text: UTF8_DECODER.decode(bytes) })
  } catch {
    return UNREADABLE_FILE
  }
}

/**
 * Answers whether a failure means that no file exists at a path.
 *
 * @param error - Untrusted failure of an open.
 * @returns True for an error whose code is `ENOENT`.
 */
function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}
