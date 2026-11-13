import {
  groqApiKeySchema,
  llmProviderSchema,
  llmProviderSettingsSchema,
  ollamaApiKeySchema,
  providerAddressSchema,
  type LlmProvider
} from "@lys/share"
import * as z from "zod"
import {
  DEFAULT_LM_STUDIO_ADDRESS,
  DEFAULT_OLLAMA_ADDRESS,
  type LlmProviderAccess
} from "../../modules/llm/llmProviderAccess"
import { readSettingsFileText } from "./settingsFile"

/**
 * What reading one provider from the settings file found.
 *
 * @remarks `configured`: the provider is on, and how to reach it. `off`: the
 * provider is not on. The `providers.enabled` list names the providers that
 * are on; a file without that list was saved before several providers could
 * be on, and its `providers.active` provider is the one on, LM Studio when it
 * names none. A missing file or group therefore means LM Studio on at its
 * default address and every other provider off. `missing-key`: the provider
 * is on and needs an API key, and none is saved. `unreadable`: the file
 * cannot be read, is larger than the limit {@link readSettingsFileText}
 * applies, is not UTF-8, or is not a JSON object whose `providers` group and
 * the key the provider needs follow the settings rules; a `providers.enabled`
 * list naming a provider twice, or a provider Lys does not know, breaks those
 * rules, as it does for the desktop host. A read or decode failure is never
 * reported as a default.
 */
export type LlmProviderAccessRead =
  | Readonly<{
      /** The provider is on and reachable as the settings say. */
      status: "configured"
      /** How to reach it; may hold a secret key. */
      access: LlmProviderAccess
    }>
  | Readonly<{
      /** The provider is not on. */
      status: "off"
    }>
  | Readonly<{
      /** The provider is on and needs a key that is not saved. */
      status: "missing-key"
      /** Provider whose key is missing. */
      provider: "ollamaCloud" | "groq"
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
 * `secrets` group; every other group, and every other field of `secrets`, is
 * dropped unread, so a group it does not know never makes a provider
 * unreadable. The `providers` group follows the rules the desktop host
 * reads it by, so the backend never reaches a provider from a file the host
 * refuses: a field the group does not have is refused; `enabled`, when
 * present, is a list naming each provider at most once, and an empty list
 * turns every provider off; `active`, when present, names a provider even
 * when `enabled` makes it unused. Keys stay unchecked here, so a malformed
 * key of another provider than the one read does not matter.
 */
const providerSettingsDocumentSchema = z.object({
  providers: z
    .strictObject({
      enabled: llmProviderSettingsSchema.unwrap().shape.enabled.optional(),
      active: llmProviderSchema.optional(),
      lmStudio: z
        .object({ address: providerAddressSchema.nullable().optional() })
        .optional(),
      ollama: z
        .object({ address: providerAddressSchema.nullable().optional() })
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

/** What this reader takes from a missing file: no group, so the defaults. */
const MISSING_PROVIDER_SETTINGS_DOCUMENT: ProviderSettingsDocument =
  Object.freeze({})

/** Read result when the file cannot be read as a settings document. */
const UNREADABLE_SETTINGS: LlmProviderAccessRead = Object.freeze({
  status: "unreadable"
})

/** Read result for a provider that is not on. */
const OFF_PROVIDER: LlmProviderAccessRead = Object.freeze({ status: "off" })

/**
 * Reads how to reach one provider from the desktop's settings file.
 *
 * @param settingsFilePath - Absolute path of `settings.json`.
 * @param provider - Provider to read.
 * @returns What the file holds for the provider, as
 * {@link LlmProviderAccessRead} describes. Each call reads the file again.
 * @throws Only when closing the opened file fails.
 * @remarks Reads at most the bytes {@link readSettingsFileText} allows and
 * never writes. Parse failures are dropped, because JSON parse messages quote
 * the text, which can hold keys. The desktop host replaces the file
 * atomically, so a read sees a whole document.
 */
export async function readLlmProviderAccess(
  settingsFilePath: string,
  provider: LlmProvider
): Promise<LlmProviderAccessRead> {
  const file = await readSettingsFileText(settingsFilePath)
  switch (file.status) {
    case "missing":
      return buildLlmProviderAccessRead(
        MISSING_PROVIDER_SETTINGS_DOCUMENT,
        provider
      )
    case "unreadable":
      return UNREADABLE_SETTINGS
    case "read":
      return parseLlmProviderAccess(file.text, provider)
  }
}

/**
 * Finds how to reach one provider, for a connection attempt.
 *
 * @param settingsFilePath - Absolute path of `settings.json`.
 * @param provider - Provider to find.
 * @returns The access {@link readLlmProviderAccess} finds configured, or
 * undefined when the provider is off.
 * @throws `The model provider is on but has no saved API key.`, whose cause
 * names the provider, or `The settings file could not be read.`; neither
 * holds file text or a key.
 */
export async function findLlmProviderAccess(
  settingsFilePath: string,
  provider: LlmProvider
): Promise<LlmProviderAccess | undefined> {
  const read = await readLlmProviderAccess(settingsFilePath, provider)
  switch (read.status) {
    case "configured":
      return read.access
    case "off":
      return undefined
    case "missing-key":
      throw new Error("The model provider is on but has no saved API key.", {
        cause: new Error(`No API key is saved for ${read.provider}.`)
      })
    case "unreadable":
      throw new Error("The settings file could not be read.")
  }
}

/**
 * Parses one provider's access out of settings file text.
 *
 * @param text - Text of the settings file.
 * @param provider - Provider to read.
 * @returns The provider's access, `off`, `missing-key`, or `unreadable`.
 */
function parseLlmProviderAccess(
  text: string,
  provider: LlmProvider
): LlmProviderAccessRead {
  const document = parseProviderSettingsDocument(text)
  if (document === undefined) return UNREADABLE_SETTINGS
  return buildLlmProviderAccessRead(document, provider)
}

/**
 * Builds what the settings say about one provider.
 *
 * @param document - The part of the settings document this reader uses.
 * @param provider - Provider to read.
 * @returns `off` when the provider is not on; otherwise its access at the
 * saved or default address, or with its saved key, `missing-key`, or
 * `unreadable` for a key that fails the key rule.
 */
function buildLlmProviderAccessRead(
  document: ProviderSettingsDocument,
  provider: LlmProvider
): LlmProviderAccessRead {
  if (!listEnabledLlmProviders(document).includes(provider)) {
    return OFF_PROVIDER
  }
  const providers = document.providers
  switch (provider) {
    case "lmStudio":
      return buildConfiguredRead({
        provider: "lmStudio",
        address: providers?.lmStudio?.address ?? DEFAULT_LM_STUDIO_ADDRESS
      })
    case "ollama":
      return buildConfiguredRead({
        provider: "ollama",
        address: providers?.ollama?.address ?? DEFAULT_OLLAMA_ADDRESS
      })
    case "ollamaCloud":
      return parseOllamaCloudAccess(document.secrets?.ollamaApiKey)
    case "groq":
      return parseGroqAccess(document.secrets?.groqApiKey)
  }
}

/**
 * Lists the providers the settings turn on.
 *
 * @param document - The part of the settings document this reader uses.
 * @returns The `enabled` list when the file has one; otherwise the one
 * provider `active` names, LM Studio when it names none or the group is
 * missing, as a file saved before several providers could be on means.
 */
function listEnabledLlmProviders(
  document: ProviderSettingsDocument
): readonly LlmProvider[] {
  const providers = document.providers
  if (providers?.enabled !== undefined) return providers.enabled
  return [providers?.active ?? "lmStudio"]
}

/**
 * Builds the access of Ollama Cloud from the saved key.
 *
 * @param value - Saved `ollamaApiKey` value, unchecked.
 * @returns The access, `missing-key` for no key or `null`, or `unreadable`
 * for a value that fails the key rule.
 */
function parseOllamaCloudAccess(value: unknown): LlmProviderAccessRead {
  if (value === undefined || value === null) {
    return Object.freeze({ status: "missing-key", provider: "ollamaCloud" })
  }
  const parsed = ollamaApiKeySchema.safeParse(value)
  if (!parsed.success) return UNREADABLE_SETTINGS
  return buildConfiguredRead({ provider: "ollamaCloud", apiKey: parsed.data })
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
 * @param access - How to reach the provider.
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
