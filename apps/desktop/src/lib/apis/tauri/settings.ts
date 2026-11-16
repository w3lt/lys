import {
  emailPasswordSchema,
  emailSettingsSchema,
  groqApiKeySchema,
  LLM_PROVIDERS,
  llmProviderSettingsSchema,
  locationSettingsSchema,
  mcpSettingsSchema,
  ollamaApiKeySchema,
  tavilyApiKeySchema,
  type EmailAccount,
  type EmailAccountCandidate,
  type EmailPassword,
  type EmailSettings,
  type LlmModelReference,
  type McpSettings,
  type McpSettingsCandidate,
  type ModelLoadConfiguration
} from "@lys/share"

import {
  buildEmailMailboxAccountSettings,
  type EmailMailbox
} from "@/lib/models/email-mailbox"
import type {
  GenerationSettings,
  LoadConfigurationSettings,
  LocationSettings,
  LysSettings,
  ProvidersSettings,
  RuntimeAutoStartSettings,
  RuntimeSettings,
  SecretsSettings,
  ToolSettings
} from "@/lib/store/settings"
import { invoke } from "@tauri-apps/api/core"

/**
 * The `runtime` group as the settings document holds it.
 *
 * @remarks Matches Rust's `RunTimeSettings` field for field. The default
 * model is a bare key here; {@link buildRuntimeSettings} reads it as a
 * reference, and no save ever writes it.
 */
type SettingsDocumentRuntime = {
  /** Whether desktop initialization requests backend startup. */
  readonly autoStartBackend: boolean
  /** Whether desktop initialization starts vmo, Lys's page reader. */
  readonly autoStartVmo: boolean
  /** Key of the model a new conversation uses, or null. */
  readonly defaultModel: string | null
  /** Backend origin shown in runtime settings. */
  readonly backendAddress: string
}

/**
 * The `loadConfiguration` group as the settings document holds it.
 *
 * @remarks Matches Rust's `LoadConfigurationSettings` field for field. JSON
 * has no map, so the per-model settings are one object whose keys are model
 * keys. That object stays inside this adapter; the rest of the renderer reads
 * the map of {@link LoadConfigurationSettings}.
 */
type SettingsDocumentLoadConfiguration = {
  /** Settings for every model, used where a model has none of its own. */
  readonly default: ModelLoadConfiguration
  /** Settings each model has of its own, as one object keyed by model key. */
  readonly models: Readonly<Record<string, ModelLoadConfiguration>>
}

/**
 * The `secrets` group as the settings document holds it.
 *
 * @remarks Matches Rust's `SecretsSettings`; the keys are plain text here and
 * branded only after {@link buildSecretsSettings} parses them.
 */
type SettingsDocumentSecrets = {
  /** Saved Tavily key, or null. */
  readonly tavilyApiKey: string | null
  /** Saved key of Ollama Cloud, or null. */
  readonly ollamaApiKey: string | null
  /** Saved Groq key, or null. */
  readonly groqApiKey: string | null
  /** Saved password of the person's email account, or null. */
  readonly emailPassword: string | null
  /** Saved password of Lys's own email account, or null. */
  readonly lysEmailPassword: string | null
}

/**
 * The `providers` group as the settings document holds it.
 *
 * @remarks Matches Rust's `ProvidersSettings` as Rust writes it, after it
 * read an older file's single `active` provider as that provider on; the
 * providers and the addresses are plain text here and checked and branded
 * only after {@link buildProvidersSettings} parses them.
 */
type SettingsDocumentProviders = {
  /** Providers that are on, each once. */
  readonly enabled: readonly string[]
  /** LM Studio's server. */
  readonly lmStudio: { readonly address: string | null }
  /** The local Ollama server. */
  readonly ollama: { readonly address: string | null }
}

/**
 * The `tools` group as the settings document holds it.
 *
 * @remarks Matches Rust's `ToolSettings`. JSON has no set or map, so the
 * Just run names are one array, which Rust stores in ascending order with
 * each name once, and the switches one object keyed by tool name, which Rust
 * stores in ascending name order. Both stay inside this adapter; the rest of
 * the renderer reads the set and the map of {@link ToolSettings}. Rust stores
 * the approved folders in ascending order, each once, and leaves the list out
 * when it is empty.
 */
type SettingsDocumentTools = {
  /** Names of the tools on Just run. */
  readonly justRun: readonly string[]
  /** Whether each tool the person switched is on, keyed by tool name. */
  readonly switches: Readonly<Record<string, boolean>>
  /** Paths of the folders tools may use; absent when none is listed. */
  readonly approvedFolders?: readonly string[]
}

/**
 * The `location` group as the settings document holds it.
 *
 * @remarks Matches Rust's `LocationSettings`; the names are plain text here
 * and branded only after {@link buildLocationSettings} parses them.
 */
type SettingsDocumentLocation = {
  /** Saved city, or null. */
  readonly city: string | null
  /** Saved region, or null. */
  readonly region: string | null
  /** Saved country, or null. */
  readonly country: string | null
}

/**
 * The `mcp` group as the settings document holds it.
 *
 * @remarks Matches Rust's `McpSettings`; the servers and the switches are
 * plain JSON here and become the shared, frozen form only after
 * {@link buildMcpSettings} parses them.
 */
type SettingsDocumentMcp = McpSettingsCandidate

/**
 * The `email` group as the settings document holds it.
 *
 * @remarks Matches Rust's `EmailSettings`; the account is plain JSON here
 * and becomes the shared, frozen form only after {@link buildEmailSettings}
 * parses it.
 */
type SettingsDocumentEmail = {
  /** The person's saved account, or null. */
  readonly account: EmailAccountCandidate | null
  /** Lys's own saved account, or null. */
  readonly lysAccount: EmailAccountCandidate | null
}

/**
 * Complete settings document as the Tauri settings commands exchange it.
 *
 * @remarks Matches Rust's `LysSettings` field for field: `load_settings`
 * resolves with it after Rust validation and defaulting, and `save_settings`
 * takes it as the document to write.
 */
type SettingsDocument = {
  /** Backend process and default-model settings, the model as a key. */
  readonly runtime: SettingsDocumentRuntime
  /** Sampling settings applied to the next request. */
  readonly generation: GenerationSettings
  /** Default and per-model load settings, the latter as one object. */
  readonly loadConfiguration: SettingsDocumentLoadConfiguration
  /** Secrets, with the keys as plain text. */
  readonly secrets: SettingsDocumentSecrets
  /** Providers that are on, with the addresses as plain text. */
  readonly providers: SettingsDocumentProviders
  /** Tool choices, with the names on Just run as one array. */
  readonly tools: SettingsDocumentTools
  /** Saved location, with the names as plain text. */
  readonly location: SettingsDocumentLocation
  /** MCP servers, as plain JSON. */
  readonly mcp: SettingsDocumentMcp
  /** Email account, as plain JSON. */
  readonly email: SettingsDocumentEmail
}

/**
 * The part of a shared key schema the adapter uses: it checks saved text and
 * brands it as one service's key.
 *
 * @typeParam TApiKey - Branded key of the service.
 */
type ApiKeySchema<TApiKey> = {
  /** Checks text, never throwing; a failure holds no key. */
  readonly safeParse: (
    value: string
  ) =>
    | { readonly success: true; readonly data: TApiKey }
    | { readonly success: false }
}

/**
 * Brands one saved key with its service's key schema.
 *
 * @typeParam TApiKey - Branded key of the service.
 * @param schema - Shared key schema of the service.
 * @param apiKey - Saved key, or null.
 * @param serviceName - Service named in the error.
 * @returns The branded key, or null when none is saved.
 * @throws If the key fails the schema, which Rust's validation rules out; the
 * error never contains the key.
 */
function buildApiKey<TApiKey>(
  schema: ApiKeySchema<TApiKey>,
  apiKey: string | null,
  serviceName: string
): TApiKey | null {
  if (apiKey === null) return null
  const parsed = schema.safeParse(apiKey)
  if (!parsed.success) {
    throw new Error(
      `The settings file holds an invalid ${serviceName} API key.`
    )
  }
  return parsed.data
}

/**
 * Builds the renderer's secrets from the document group.
 *
 * @param secrets - Group Rust validated.
 * @returns The secrets with each key branded.
 * @throws If a key fails its shared key schema, which Rust's validation
 * rules out; the error never contains the key.
 */
function buildSecretsSettings(
  secrets: SettingsDocumentSecrets
): SecretsSettings {
  return {
    tavilyApiKey: buildApiKey(
      tavilyApiKeySchema,
      secrets.tavilyApiKey,
      "Tavily"
    ),
    ollamaApiKey: buildApiKey(
      ollamaApiKeySchema,
      secrets.ollamaApiKey,
      "Ollama"
    ),
    groqApiKey: buildApiKey(groqApiKeySchema, secrets.groqApiKey, "Groq"),
    emailPassword: buildEmailPassword(secrets.emailPassword),
    lysEmailPassword: buildEmailPassword(secrets.lysEmailPassword)
  }
}

/**
 * Brands the saved email password.
 *
 * @param emailPassword - Saved password, or null.
 * @returns The branded password, or null when none is saved.
 * @throws If the password fails the shared password rule, which Rust's
 * validation rules out; the error never contains the password.
 */
function buildEmailPassword(
  emailPassword: string | null
): EmailPassword | null {
  if (emailPassword === null) return null
  const parsed = emailPasswordSchema.safeParse(emailPassword)
  if (!parsed.success) {
    throw new Error("The settings file holds an invalid email password.")
  }
  return parsed.data
}

/**
 * Builds the renderer's providers group from the document group.
 *
 * @param providers - Group Rust validated.
 * @returns The providers that are on and the addresses, branded.
 * @throws If the group fails the shared provider settings schema, which
 * Rust's validation rules out.
 */
function buildProvidersSettings(
  providers: SettingsDocumentProviders
): ProvidersSettings {
  const parsed = llmProviderSettingsSchema.safeParse(providers)
  if (!parsed.success) {
    throw new Error("The settings file holds an invalid providers group.")
  }
  return parsed.data
}

/**
 * Builds the renderer's runtime settings from the document group.
 *
 * @param runtime - Group Rust validated.
 * @param providers - Providers the same document turns on.
 * @returns The group with its default model as a reference: the stored key on
 * the first provider that is on, in provider order, or null when no key is
 * stored or no provider is on.
 */
function buildRuntimeSettings(
  runtime: SettingsDocumentRuntime,
  providers: ProvidersSettings
): RuntimeSettings {
  return {
    autoStartBackend: runtime.autoStartBackend,
    autoStartVmo: runtime.autoStartVmo,
    defaultModel: buildDefaultModel(runtime.defaultModel, providers),
    backendAddress: runtime.backendAddress
  }
}

/**
 * Reads the stored default model's key as a reference.
 *
 * @param modelKey - Stored key, or null.
 * @param providers - Providers that are on.
 * @returns The key on the first provider that is on, in provider order, or
 * null when no key is stored or no provider is on.
 * @remarks An empty key names no model, so it reads as none.
 */
function buildDefaultModel(
  modelKey: string | null,
  providers: ProvidersSettings
): LlmModelReference | null {
  if (modelKey === null || modelKey.length === 0) return null
  const provider = LLM_PROVIDERS.find((candidate) =>
    providers.enabled.includes(candidate)
  )
  return provider === undefined ? null : { provider, modelKey }
}

/**
 * Builds the renderer's location from the document group.
 *
 * @param location - Group Rust validated.
 * @returns The location with its names branded.
 * @throws If the group fails the shared location schema, which Rust's
 * validation rules out; the error never contains the location.
 */
function buildLocationSettings(
  location: SettingsDocumentLocation
): LocationSettings {
  const parsed = locationSettingsSchema.safeParse(location)
  if (!parsed.success) {
    throw new Error("The settings file holds an invalid location.")
  }
  return parsed.data
}

/**
 * Builds the renderer's MCP servers from the document group.
 *
 * @param mcp - Group Rust validated.
 * @returns The servers as the shared `mcp` group schema returns them,
 * frozen.
 * @throws If the group fails the shared schema, which Rust's validation
 * rules out; the error never contains a command, URL, environment value, or
 * header.
 */
function buildMcpSettings(mcp: SettingsDocumentMcp): McpSettings {
  const parsed = mcpSettingsSchema.safeParse(mcp)
  if (!parsed.success) {
    throw new Error("The settings file holds invalid MCP server settings.")
  }
  return parsed.data
}

/**
 * Builds the renderer's email account from the document group.
 *
 * @param email - Group Rust validated.
 * @returns The group as the shared `email` group schema returns it, frozen.
 * @throws If the group fails the shared schema, which Rust's validation
 * rules out; the error never contains the account.
 */
function buildEmailSettings(email: SettingsDocumentEmail): EmailSettings {
  const parsed = emailSettingsSchema.safeParse(email)
  if (!parsed.success) {
    throw new Error("The settings file holds an invalid email account.")
  }
  return parsed.data
}

/**
 * Builds the document group that stores the renderer's tool choices.
 *
 * @param tools - Tool choices owned by the desktop store.
 * @returns A newly owned group listing the Just run names in the set's
 * order, the switches as an object with one property of its own per map
 * entry, also for a tool name that names a member of the object prototype,
 * and the approved folders in the list's order, left out when there are
 * none, as Rust writes them; Rust stores all three in ascending order.
 */
function buildSettingsDocumentTools(
  tools: ToolSettings
): SettingsDocumentTools {
  const group: SettingsDocumentTools = {
    justRun: [...tools.justRunToolNames],
    switches: Object.fromEntries(tools.switches)
  }
  return tools.approvedFolderPaths.length === 0
    ? group
    : { ...group, approvedFolders: [...tools.approvedFolderPaths] }
}

/**
 * Builds the renderer's tool choices from the document group.
 *
 * @param tools - Group Rust validated.
 * @returns Newly owned choices: the Just run names as a set, the switches
 * as a map with one entry per property of the document's object, whatever
 * the text of the name, and the approved folders as a frozen list, empty when
 * the document lists none.
 */
function buildToolSettings(tools: SettingsDocumentTools): ToolSettings {
  return {
    justRunToolNames: new Set(tools.justRun),
    switches: new Map(Object.entries(tools.switches)),
    approvedFolderPaths: Object.freeze([...(tools.approvedFolders ?? [])])
  }
}

/**
 * Builds the renderer's settings from a settings document.
 *
 * @param settingsDocument - Document a Tauri settings command resolved with,
 * already validated by Rust.
 * @returns Settings holding the document's groups. The default model is a
 * reference, as {@link buildRuntimeSettings} builds it. The per-model load
 * settings are a newly owned map with one entry per key of the document's
 * object, whatever the text of the key, the tool choices are newly owned, as
 * {@link buildToolSettings} builds them, the MCP servers are parsed by
 * {@link buildMcpSettings}, and the email account by
 * {@link buildEmailSettings}.
 * @throws If a key, the password, the providers group, the location, the
 * MCP servers, or the email account fail their shared schema, which Rust's
 * validation rules out.
 */
function buildLysSettings(settingsDocument: SettingsDocument): LysSettings {
  const models = new Map(
    Object.entries(settingsDocument.loadConfiguration.models)
  )
  const loadConfiguration: LoadConfigurationSettings = {
    default: settingsDocument.loadConfiguration.default,
    models
  }
  const providers = buildProvidersSettings(settingsDocument.providers)
  return {
    runtime: buildRuntimeSettings(settingsDocument.runtime, providers),
    generation: settingsDocument.generation,
    loadConfiguration,
    secrets: buildSecretsSettings(settingsDocument.secrets),
    providers,
    tools: buildToolSettings(settingsDocument.tools),
    location: buildLocationSettings(settingsDocument.location),
    mcp: buildMcpSettings(settingsDocument.mcp),
    email: buildEmailSettings(settingsDocument.email)
  }
}

/**
 * Loads desktop settings from the Tauri-persisted settings file.
 *
 * @returns The settings of the complete document after Rust validation and
 * defaulting, with the per-model load settings as a map keyed by model key,
 * the tools on Just run as a set, the tool switches as a map keyed by tool
 * name, and the MCP servers and the email account parsed by their shared
 * group schemas.
 * @throws The Tauri invoke rejection when the settings path cannot be read or parsed.
 * @throws An `Error` when a group fails its shared schema after Rust
 * accepted it; the message holds no setting value.
 */
export async function loadSettings(): Promise<LysSettings> {
  return buildLysSettings(await readSettingsDocument())
}

/**
 * Reads the settings document through the Tauri settings command.
 *
 * @returns The complete document after Rust validation and defaulting.
 * @throws The Tauri invoke rejection when the settings path cannot be read or
 * parsed.
 */
function readSettingsDocument(): Promise<SettingsDocument> {
  return invoke<SettingsDocument>("load_settings")
}

/**
 * Sends a settings document to the Tauri settings command.
 *
 * @param newSettings - Complete document to write, every group in the form
 * the settings file keeps.
 * @returns Resolves after the native settings file write completes.
 * @throws The Tauri invoke rejection for command deserialization,
 * serialization, or file-writing failures.
 * @remarks The named newSettings argument matches Rust's new_settings
 * parameter. Each group save reads the document, replaces its own group, and
 * writes the rest as read, so the desktop never rewrites a group it does not
 * own, such as the stored default model's key.
 */
async function writeSettingsDocument(
  newSettings: SettingsDocument
): Promise<void> {
  await invoke("save_settings", { newSettings })
}

/**
 * Persists generation controls while preserving other groups already on disk.
 * @param generation - Accepted controls sampled by the application autosave owner.
 * @returns Resolves after the merged settings document is written by Tauri.
 * @throws The native load or save rejection; no replacement is written if loading fails.
 * @remarks The application store serializes this read-modify-write operation
 * with the other settings-group saves, so that overlapping saves cannot write
 * back each other's stale group.
 */
export async function saveGenerationSettings(
  generation: GenerationSettings
): Promise<void> {
  const persistedDocument = await readSettingsDocument()
  await writeSettingsDocument({ ...persistedDocument, generation })
}

/**
 * Persists the per-model load settings while preserving everything else
 * already on disk.
 * @param loadConfiguration - Load settings sampled by the application autosave
 * owner. Only its per-model settings are written; its default is not.
 * @returns Resolves after the merged settings document is written by Tauri.
 * @throws The native load or save rejection; no replacement is written if loading fails.
 * @remarks The stored default is kept as it is on disk, like the other groups.
 * Only a hand edit of the settings file changes it, and the store's copy was
 * read at startup, so writing that copy would undo an edit made since. The
 * application store serializes this read-modify-write operation with the
 * other settings-group saves, so that overlapping saves cannot write back
 * each other's stale group.
 */
export async function saveLoadConfigurationSettings(
  loadConfiguration: LoadConfigurationSettings
): Promise<void> {
  const persistedDocument = await readSettingsDocument()
  const savedLoadConfiguration: SettingsDocumentLoadConfiguration = {
    default: persistedDocument.loadConfiguration.default,
    models: Object.fromEntries(loadConfiguration.models)
  }
  await writeSettingsDocument({
    ...persistedDocument,
    loadConfiguration: savedLoadConfiguration
  })
}

/**
 * Persists some secrets while preserving the other secrets and everything
 * else already on disk.
 * @param changedSecrets - Secrets to save; a null key removes the saved one,
 * and a key not given keeps the value on disk.
 * @returns Resolves after the merged settings document is written by Tauri,
 * which replaces the file atomically and owner-only.
 * @throws The native load or save rejection; no replacement is written if
 * loading fails.
 * @remarks The application store serializes this read-modify-write operation
 * with the other settings-group saves, so that overlapping saves cannot write
 * back each other's stale group or each other's stale key.
 */
export async function saveSecretsSettings(
  changedSecrets: Partial<SecretsSettings>
): Promise<void> {
  const persistedDocument = await readSettingsDocument()
  const secrets: SettingsDocumentSecrets = {
    ...persistedDocument.secrets,
    ...changedSecrets
  }
  await writeSettingsDocument({ ...persistedDocument, secrets })
}

/**
 * Persists the providers that are on and their addresses while preserving
 * everything else already on disk.
 * @param providers - Providers that are on and addresses to save.
 * @returns Resolves after the merged settings document is written by Tauri.
 * @throws The native load or save rejection; no replacement is written if
 * loading fails.
 * @remarks The application store serializes this read-modify-write operation
 * with the other settings-group saves, so that overlapping saves cannot write
 * back each other's stale group.
 */
export async function saveProviderSettings(
  providers: ProvidersSettings
): Promise<void> {
  const persistedDocument = await readSettingsDocument()
  await writeSettingsDocument({ ...persistedDocument, providers })
}

/**
 * Persists the tool choices while preserving everything else already on disk.
 * @param tools - Tool choices to save; every name in the set and every
 * switch in the map is written, also for a tool Lys does not list now, and
 * every approved folder.
 * @returns Resolves after the merged settings document is written by Tauri.
 * @throws The native load or save rejection; no replacement is written if
 * loading fails.
 * @remarks The application store serializes this read-modify-write operation
 * with the other settings-group saves, so that overlapping saves cannot write
 * back each other's stale group.
 */
export async function saveToolSettings(tools: ToolSettings): Promise<void> {
  const persistedDocument = await readSettingsDocument()
  await writeSettingsDocument({
    ...persistedDocument,
    tools: buildSettingsDocumentTools(tools)
  })
}

/**
 * Persists the location while preserving everything else already on disk.
 * @param location - Location to save; null parts are written as null, and a
 * location whose parts are all null removes the saved one.
 * @returns Resolves after the merged settings document is written by Tauri,
 * which replaces the file atomically and owner-only.
 * @throws The native load or save rejection; no replacement is written if
 * loading fails.
 * @remarks The application store serializes this read-modify-write operation
 * with the other settings-group saves, so that overlapping saves cannot write
 * back each other's stale group.
 */
export async function saveLocationSettings(
  location: LocationSettings
): Promise<void> {
  const persistedDocument = await readSettingsDocument()
  await writeSettingsDocument({ ...persistedDocument, location })
}

/**
 * Persists the two startup switches while preserving everything else already
 * on disk.
 * @param autoStart - Startup switches sampled by the application autosave
 * owner.
 * @returns Resolves after the merged settings document is written by Tauri.
 * @throws The native load or save rejection; no replacement is written if
 * loading fails.
 * @remarks The runtime group is written with the given switches and the
 * default model's key and backend address as they are on disk: the store's
 * copies of those two are session-only. The application store serializes this
 * read-modify-write operation with the other settings-group saves, so that
 * overlapping saves cannot write back each other's stale group.
 */
export async function saveRuntimeAutoStartSettings(
  autoStart: RuntimeAutoStartSettings
): Promise<void> {
  const persistedDocument = await readSettingsDocument()
  const runtime: SettingsDocumentRuntime = {
    ...persistedDocument.runtime,
    autoStartBackend: autoStart.autoStartBackend,
    autoStartVmo: autoStart.autoStartVmo
  }
  await writeSettingsDocument({ ...persistedDocument, runtime })
}

/**
 * Persists one mailbox's email account and its password together while
 * preserving everything else already on disk, the other mailbox's account
 * included.
 * @param mailbox - Whose account it is: the person's, kept in `account`
 * and `emailPassword`, or Lys's own, kept in `lysAccount` and
 * `lysEmailPassword`.
 * @param account - Account to save, or null to remove the saved one.
 * @param password - Password of the account, or null to remove the saved
 * one; a secret.
 * @returns Resolves after the merged settings document is written by Tauri,
 * which validates both groups and replaces the file atomically and
 * owner-only.
 * @throws The native load or save rejection, including Rust's refusal of a
 * group that breaks its rules, or an `Error` when a group read from disk
 * fails its shared schema; no replacement is written if loading fails.
 * @remarks One write replaces the mailbox's account in the `email` group and
 * its password in the secrets group, so the file never holds an account
 * without its password, which the backend would refuse. Every other group is
 * written as read, so the stored default model's key is never rewritten. The
 * application store
 * serializes this read-modify-write operation with the other settings-group
 * saves, so that overlapping saves cannot write back each other's stale
 * group or each other's stale key.
 */
export async function saveEmailAccountSettings(
  mailbox: EmailMailbox,
  account: EmailAccount | null,
  password: EmailPassword | null
): Promise<void> {
  const persistedDocument = await readSettingsDocument()
  const { secrets, email } = buildEmailMailboxAccountSettings(
    buildLysSettings(persistedDocument),
    mailbox,
    { account, password }
  )
  await writeSettingsDocument({ ...persistedDocument, secrets, email })
}

/**
 * Persists the MCP servers while preserving everything else already on disk.
 * @param mcp - MCP group to save: the added servers in list order, each with
 * its switch, and the switches of the servers Lys ships; an empty list
 * removes every added server.
 * @returns Resolves after the merged settings document is written by Tauri,
 * which validates the group and replaces the file atomically and
 * owner-only.
 * @throws The native load or save rejection, including Rust's refusal of a
 * group that breaks its rules; no replacement is written if loading fails.
 * @remarks The backend applies the saved group only when it starts or when
 * the desktop asks it to apply the group again. The application store
 * serializes this read-modify-write operation with the other settings-group
 * saves, so that overlapping saves cannot write back each other's stale
 * group.
 */
export async function saveMcpSettings(mcp: McpSettings): Promise<void> {
  const persistedDocument = await readSettingsDocument()
  await writeSettingsDocument({ ...persistedDocument, mcp })
}
