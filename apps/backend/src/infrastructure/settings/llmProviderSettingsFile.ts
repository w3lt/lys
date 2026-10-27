import {
  groqApiKeySchema,
  llmProviderSchema,
  ollamaApiKeySchema,
  ollamaModeSchema,
  providerAddressSchema
} from "@lys/share"
import * as z from "zod"
import {
  DEFAULT_LM_STUDIO_ADDRESS,
  DEFAULT_OLLAMA_ADDRESS,
  type LlmProviderAccess
} from "../../modules/llm/llmProviderAccess"
import { readSettingsFileText } from "./settingsFile"

/**
 * What reading the active provider from the settings file found.
 *
 * @remarks `configured`: how to reach the provider; a missing file, group, or
 * field means LM Studio at its default address, as before providers could be
 * chosen. `missing-key`: the active provider needs an API key and none is
 * saved. `unreadable`: the file cannot be read, is larger than the limit
 * {@link readSettingsFileText} applies, is not UTF-8, or is not a JSON object
 * whose `providers` group and the key it needs follow the settings rules. A
 * read or decode failure is never reported as a default.
 */
export type LlmProviderAccessRead =
  | Readonly<{
      /** The settings name a reachable provider. */
      status: "configured"
      /** How to reach it; may hold a secret key. */
      access: LlmProviderAccess
    }>
  | Readonly<{
      /** The active provider needs a key that is not saved. */
      status: "missing-key"
      /** Provider whose key is missing. */
      provider: "ollama" | "groq"
    }>
  | Readonly<{
      /** The file could not be read as a settings document. */
      status: "unreadable"
    }>

/**
 * Validates the part of the settings document this reader uses.
 *
 * @remarks The desktop host owns and validates the whole document. This
 * reader takes only the `providers` group and the two provider keys of the
 * `secrets` group; every other group and field is dropped unread, so a group
 * it does not know never makes the provider unreadable. Keys stay unchecked
 * here, so a malformed key of a provider that is not active does not matter.
 */
const providerSettingsDocumentSchema = z.object({
  providers: z
    .object({
      active: llmProviderSchema.optional(),
      lmStudio: z
        .object({ address: providerAddressSchema.nullable().optional() })
        .optional(),
      ollama: z
        .object({
          mode: ollamaModeSchema.optional(),
          address: providerAddressSchema.nullable().optional()
        })
        .optional()
    })
    .optional(),
  secrets: z
    .object({
      ollamaApiKey: z.unknown().optional(),
      groqApiKey: z.unknown().optional()
    })
    .optional()
})

/** The part of the settings document this reader uses. */
type ProviderSettingsDocument = z.infer<typeof providerSettingsDocumentSchema>

/** Read result when the file cannot be read as a settings document. */
const UNREADABLE_SETTINGS: LlmProviderAccessRead = Object.freeze({
  status: "unreadable"
})

/** Read result when the file names no provider: LM Studio at its default. */
const DEFAULT_PROVIDER: LlmProviderAccessRead = Object.freeze({
  status: "configured",
  access: Object.freeze({
    provider: "lmStudio",
    address: DEFAULT_LM_STUDIO_ADDRESS
  })
})

/**
 * Reads how to reach the active provider from the desktop's settings file.
 *
 * @param settingsFilePath - Absolute path of `settings.json`.
 * @returns What the file holds, as {@link LlmProviderAccessRead} describes.
 * Each call reads the file again.
 * @throws Only when closing the opened file fails.
 * @remarks Reads at most the bytes {@link readSettingsFileText} allows and
 * never writes. Parse failures are dropped, because JSON parse messages quote
 * the text, which can hold keys. The desktop host replaces the file
 * atomically, so a read sees a whole document.
 */
export async function readLlmProviderAccess(
  settingsFilePath: string
): Promise<LlmProviderAccessRead> {
  const file = await readSettingsFileText(settingsFilePath)
  switch (file.status) {
    case "missing":
      return DEFAULT_PROVIDER
    case "unreadable":
      return UNREADABLE_SETTINGS
    case "read":
      return parseLlmProviderAccess(file.text)
  }
}

/**
 * Finds how to reach the active provider, for a connection attempt.
 *
 * @param settingsFilePath - Absolute path of `settings.json`.
 * @returns The access {@link readLlmProviderAccess} finds configured.
 * @throws `The active model provider has no saved API key.` naming the
 * provider, or `The settings file could not be read.`; neither holds file
 * text or a key.
 */
export async function findLlmProviderAccess(
  settingsFilePath: string
): Promise<LlmProviderAccess> {
  const read = await readLlmProviderAccess(settingsFilePath)
  switch (read.status) {
    case "configured":
      return read.access
    case "missing-key":
      throw new Error("The active model provider has no saved API key.", {
        cause: new Error(`No API key is saved for ${read.provider}.`)
      })
    case "unreadable":
      throw new Error("The settings file could not be read.")
  }
}

/**
 * Parses the active provider out of settings file text.
 *
 * @param text - Text of the settings file.
 * @returns The provider's access, `missing-key`, or `unreadable`.
 */
function parseLlmProviderAccess(text: string): LlmProviderAccessRead {
  const document = parseProviderSettingsDocument(text)
  if (document === undefined) return UNREADABLE_SETTINGS
  const providers = document.providers
  switch (providers?.active ?? "lmStudio") {
    case "lmStudio":
      return buildConfiguredRead({
        provider: "lmStudio",
        address: providers?.lmStudio?.address ?? DEFAULT_LM_STUDIO_ADDRESS
      })
    case "ollama":
      return providers?.ollama?.mode === "cloud"
        ? parseOllamaCloudAccess(document.secrets?.ollamaApiKey)
        : buildConfiguredRead({
            provider: "ollama",
            mode: "local",
            address: providers?.ollama?.address ?? DEFAULT_OLLAMA_ADDRESS
          })
    case "groq":
      return parseGroqAccess(document.secrets?.groqApiKey)
  }
}

/**
 * Builds the access of Ollama's cloud from the saved key.
 *
 * @param value - Saved `ollamaApiKey` value, unchecked.
 * @returns The access, `missing-key` for no key or `null`, or `unreadable`
 * for a value that fails the key rule.
 */
function parseOllamaCloudAccess(value: unknown): LlmProviderAccessRead {
  if (value === undefined || value === null) {
    return Object.freeze({ status: "missing-key", provider: "ollama" })
  }
  const parsed = ollamaApiKeySchema.safeParse(value)
  if (!parsed.success) return UNREADABLE_SETTINGS
  return buildConfiguredRead({
    provider: "ollama",
    mode: "cloud",
    apiKey: parsed.data
  })
}

/**
 * Builds the access of Groq from the saved key.
 *
 * @param value - Saved `groqApiKey` value, unchecked.
 * @returns The access, `missing-key` for no key or `null`, or `unreadable`
 * for a value that fails the key rule.
 */
function parseGroqAccess(value: unknown): LlmProviderAccessRead {
  if (value === undefined || value === null) {
    return Object.freeze({ status: "missing-key", provider: "groq" })
  }
  const parsed = groqApiKeySchema.safeParse(value)
  if (!parsed.success) return UNREADABLE_SETTINGS
  return buildConfiguredRead({ provider: "groq", apiKey: parsed.data })
}

/**
 * Wraps an access in a frozen `configured` result.
 *
 * @param access - How to reach the active provider.
 * @returns The frozen result.
 */
function buildConfiguredRead(access: LlmProviderAccess): LlmProviderAccessRead {
  return Object.freeze({ status: "configured", access: Object.freeze(access) })
}

/**
 * Parses settings file text into the part this reader uses.
 *
 * @param text - Text of the settings file.
 * @returns The part, or undefined when the text is not JSON or the part does
 * not follow the settings rules.
 * @remarks A parse failure is dropped, never kept or logged, because its
 * message can quote the text.
 */
function parseProviderSettingsDocument(
  text: string
): ProviderSettingsDocument | undefined {
  try {
    const document: unknown = JSON.parse(text)
    const parsed = providerSettingsDocumentSchema.safeParse(document)
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}
