import { tavilyApiKeySchema, type TavilyApiKey } from "@lys/share"
import { open, type FileHandle } from "node:fs/promises"
import * as z from "zod"

/**
 * Most bytes of the settings file this reader reads, inclusive; a larger
 * file is unreadable here. The desktop's own settings stay far below it.
 */
export const MAXIMUM_SETTINGS_FILE_BYTES = 1024 * 1024

/**
 * What reading the Tavily API key from the settings file found.
 *
 * @remarks `configured`: a key that passed the key format. `missing`: no
 * file, no `secrets` group, no key field, or `null`, which are the declared
 * forms of "no key". `invalid`: the field holds something that fails the key
 * format. `unreadable`: the file cannot be read, is larger than
 * {@link MAXIMUM_SETTINGS_FILE_BYTES}, is not UTF-8, or is not a JSON object
 * whose `secrets` group, when present, is an object. A read or decode failure
 * is never reported as `missing`.
 */
export type TavilyApiKeyRead =
  | Readonly<{
      /** A usable key is saved. */
      status: "configured"
      /** The saved key; a secret. */
      apiKey: TavilyApiKey
    }>
  | Readonly<{
      /** No key is saved. */
      status: "missing"
    }>
  | Readonly<{
      /** The saved value fails the key format. */
      status: "invalid"
    }>
  | Readonly<{
      /** The file could not be read as a settings document. */
      status: "unreadable"
    }>

/** Outcome of reading the settings file's text. */
type SettingsFileText =
  | Readonly<{
      /** The file was read. */
      status: "read"
      /** Its text. */
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

/**
 * Validates the part of the settings document this reader uses.
 *
 * @remarks The desktop host owns and validates the whole document. This
 * reader takes only `secrets.tavilyApiKey`; every other group and field is
 * dropped unread, so a group it does not know never makes the key
 * unreadable, and nothing ignored is kept.
 */
const settingsSecretsSchema = z.object({
  secrets: z.object({ tavilyApiKey: z.unknown().optional() }).optional()
})

/** The part of the settings document this reader uses. */
type SettingsSecrets = z.infer<typeof settingsSecretsSchema>

/** Read result when no key is saved. */
const MISSING_KEY: TavilyApiKeyRead = Object.freeze({ status: "missing" })

/** Read result when the saved value fails the key format. */
const INVALID_KEY: TavilyApiKeyRead = Object.freeze({ status: "invalid" })

/** Read result when the file cannot be read as a settings document. */
const UNREADABLE_SETTINGS: TavilyApiKeyRead = Object.freeze({
  status: "unreadable"
})

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
 * Reads the Tavily API key from the desktop's settings file.
 *
 * @param settingsFilePath - Absolute path of `settings.json`.
 * @returns What the file holds, as {@link TavilyApiKeyRead} describes. Each
 * call reads the file again.
 * @throws Only when closing the opened file fails.
 * @remarks Reads at most {@link MAXIMUM_SETTINGS_FILE_BYTES} bytes and never
 * writes. Nothing read from the file leaves this function except a key that
 * passed the key format: parse failures are dropped, because JSON parse
 * messages quote the text, which can hold the key. The desktop host replaces
 * the file atomically, so a read sees a whole document.
 */
export async function readTavilyApiKey(
  settingsFilePath: string
): Promise<TavilyApiKeyRead> {
  const file = await readSettingsFileText(settingsFilePath)
  switch (file.status) {
    case "missing":
      return MISSING_KEY
    case "unreadable":
      return UNREADABLE_SETTINGS
    case "read":
      return parseTavilyApiKey(file.text)
  }
}

/**
 * Parses the key out of settings file text.
 *
 * @param text - Text of the settings file.
 * @returns `configured`, `missing`, `invalid`, or `unreadable` as
 * {@link TavilyApiKeyRead} describes.
 */
function parseTavilyApiKey(text: string): TavilyApiKeyRead {
  const document = parseSettingsSecrets(text)
  if (document === undefined) return UNREADABLE_SETTINGS
  const value = document.secrets?.tavilyApiKey
  if (value === undefined || value === null) return MISSING_KEY
  const parsed = tavilyApiKeySchema.safeParse(value)
  if (!parsed.success) return INVALID_KEY
  return Object.freeze({ status: "configured", apiKey: parsed.data })
}

/**
 * Parses settings file text into the part this reader uses.
 *
 * @param text - Text of the settings file.
 * @returns The part, or undefined when the text is not JSON or not an object
 * whose `secrets` group, when present, is an object.
 * @remarks A parse failure is dropped, never kept or logged, because its
 * message can quote the text.
 */
function parseSettingsSecrets(text: string): SettingsSecrets | undefined {
  try {
    const document: unknown = JSON.parse(text)
    const parsed = settingsSecretsSchema.safeParse(document)
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

/**
 * Reads the settings file's text within the size limit.
 *
 * @param path - Absolute path of the file.
 * @returns The text, `missing` when no file exists, or `unreadable`.
 * @throws Only when closing the opened file fails.
 */
async function readSettingsFileText(path: string): Promise<SettingsFileText> {
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
