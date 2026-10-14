import { tavilyApiKeySchema, type TavilyApiKey } from "@lys/share"
import * as z from "zod"
import { readSettingsFileText } from "./settingsFile"

/**
 * What reading the Tavily API key from the settings file found.
 *
 * @remarks `configured`: a key that passed the key format. `missing`: no
 * file, no `secrets` group, no key field, or `null`, which are the declared
 * forms of "no key". `invalid`: the field holds something that fails the key
 * format. `unreadable`: the file cannot be read, is larger than the limit
 * {@link readSettingsFileText} applies, is not UTF-8, or is not a JSON object
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

/**
 * Reads the Tavily API key from the desktop's settings file.
 *
 * @param settingsFilePath - Absolute path of `settings.json`.
 * @returns What the file holds, as {@link TavilyApiKeyRead} describes. Each
 * call reads the file again.
 * @throws Only when closing the opened file fails.
 * @remarks Reads at most the bytes {@link readSettingsFileText} allows and
 * never writes. Nothing read from the file leaves this function except a key that
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
