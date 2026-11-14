/**
 * The desktop's `settings.json` document as the Tauri host writes it.
 *
 * @remarks {@link DEFAULT_SETTINGS_DOCUMENT} mirrors `LysSettings::default()`
 * in `apps/desktop/src-tauri/src/settings.rs` and its group modules, key for
 * key and in the same order, so a file the fake host writes is byte-for-byte
 * what the real host writes. The native host journey compares the file the
 * real binary creates against this constant, which is the evidence that the
 * mirror is still accurate.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

/** Keys every settings document has, in the host's serialization order. */
export const SETTINGS_GROUPS = Object.freeze([
  "runtime",
  "generation",
  "loadConfiguration",
  "secrets",
  "tools",
  "location",
  "mcp",
  "providers",
  "email"
])

/** The document the host writes when no `settings.json` exists. */
export const DEFAULT_SETTINGS_DOCUMENT = Object.freeze({
  runtime: {
    autoStartBackend: true,
    autoStartVmo: true,
    defaultModel: null,
    backendAddress: "http://127.0.0.1:12345"
  },
  generation: { temperature: 0.7, replyCeiling: 2048 },
  loadConfiguration: { default: {}, models: {} },
  secrets: {
    tavilyApiKey: null,
    ollamaApiKey: null,
    groqApiKey: null,
    emailPassword: null
  },
  tools: { justRun: [], switches: {} },
  location: { city: null, region: null, country: null },
  mcp: { servers: [], builtIn: { email: { enabled: false } } },
  providers: {
    enabled: ["lmStudio"],
    lmStudio: { address: null },
    ollama: { address: null }
  },
  email: { account: null }
})

/**
 * Every provider the host knows, in provider order: the declaration order of
 * `LlmProvider` in `apps/desktop/src-tauri/src/settings/providers.rs`, which
 * is the order the host saves the `providers.enabled` list in.
 */
const LLM_PROVIDERS = Object.freeze([
  "lmStudio",
  "ollama",
  "ollamaCloud",
  "groq"
])

/** Owner-only file mode the host gives `settings.json`. */
const SETTINGS_FILE_MODE = 0o600

/**
 * Builds the document a run seeds into its scratch Lys home.
 *
 * @remarks Ollama is the one provider on, at the fake's address, and vmo's
 * autostart is off because the verification stack has no vmo: the renderer
 * would otherwise ask the host to start it on every page load and show the
 * refusal. Everything else keeps the host's default.
 * @param {string} providerAddress - `host:port` of the verification provider
 * that answers as a local Ollama server.
 * @returns {object} The seeded document.
 */
export function buildSeededSettingsDocument(providerAddress) {
  return {
    ...structuredClone(DEFAULT_SETTINGS_DOCUMENT),
    runtime: { ...DEFAULT_SETTINGS_DOCUMENT.runtime, autoStartVmo: false },
    providers: {
      enabled: ["ollama"],
      lmStudio: { address: null },
      ollama: { address: providerAddress }
    }
  }
}

/**
 * Names the settings file of a Lys home.
 *
 * @param {string} lysHome - Absolute path of the Lys home directory.
 * @returns {string} The absolute path of its `settings.json`.
 */
export function buildSettingsPath(lysHome) {
  return join(lysHome, "settings.json")
}

/**
 * Writes a settings document the way the host does: pretty-printed with a
 * trailing newline, owner-only, through a temporary file and a rename.
 *
 * @param {string} path - Absolute path of the settings file.
 * @param {object} document - The document to write.
 * @throws If the directory cannot be created or the file cannot be written.
 */
export function saveSettingsDocument(path, document) {
  mkdirSync(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
    mode: SETTINGS_FILE_MODE,
    flag: "wx"
  })
  renameSync(temporaryPath, path)
}

/**
 * Reads and parses a settings file.
 *
 * @param {string} path - Absolute path of the settings file.
 * @returns {object} The parsed document.
 * @throws If the file is missing or is not JSON.
 */
export function readSettingsDocument(path) {
  return JSON.parse(readFileSync(path, "utf8"))
}

/**
 * Reports whether a value has the shape of a settings document the host
 * would accept: an object whose keys are settings groups holding objects.
 *
 * @param {unknown} candidate - The value a caller wants to save.
 * @returns {boolean} `true` when every key is a known group with an object
 * value.
 */
export function isSettingsDocumentShape(candidate) {
  if (typeof candidate !== "object" || candidate === null) return false
  return Object.entries(candidate).every(isSettingsGroupEntry)
}

/**
 * Reports whether one key/value pair is a settings group with an object.
 *
 * @param {[string, unknown]} entry - A key and its value.
 * @returns {boolean} `true` for a known group name holding a non-null object.
 */
function isSettingsGroupEntry([name, value]) {
  return (
    SETTINGS_GROUPS.includes(name) &&
    typeof value === "object" &&
    value !== null
  )
}

/**
 * Reads a stored `providers` group the way the host reads it.
 *
 * @remarks Mirrors `ProvidersSettings` in
 * `apps/desktop/src-tauri/src/settings/providers.rs` as far as the renderer
 * can observe it. A group with an `enabled` list keeps that list. A group
 * saved before several providers could be on has none; its `active`
 * provider, or LM Studio when it names none, is the one on. The result lists
 * the providers in provider order and has no `active`, which is what the
 * host's `load_settings` answers and its `save_settings` writes. Addresses
 * are taken as stored.
 * @param {Record<string, unknown>} stored - The stored group; an empty
 * object for a document without one.
 * @returns {{enabled: string[], lmStudio: unknown, ollama: unknown}} The
 * group in the host's key order.
 * @throws If `enabled` is not a list of known providers naming each once, or
 * `active` names no known provider; the host refuses such a group too.
 */
export function parseProvidersSettingsGroup(stored) {
  const enabled = Object.hasOwn(stored, "enabled")
    ? stored.enabled
    : [stored.active ?? "lmStudio"]
  if (!isProviderList(enabled) || !isOptionalProvider(stored.active))
    throw new Error(
      "The providers group must list known providers, each once, in enabled, and name a known provider in active."
    )
  return {
    enabled: LLM_PROVIDERS.filter((provider) => enabled.includes(provider)),
    lmStudio: stored.lmStudio ?? { address: null },
    ollama: stored.ollama ?? { address: null }
  }
}

/**
 * Reports whether a value is a list of known providers naming each once.
 *
 * @param {unknown} candidate - A stored `enabled` value.
 * @returns {boolean} `true` for an array, possibly empty, of distinct
 * provider names.
 */
function isProviderList(candidate) {
  return (
    Array.isArray(candidate) &&
    candidate.every((provider) => LLM_PROVIDERS.includes(provider)) &&
    new Set(candidate).size === candidate.length
  )
}

/**
 * Reports whether a stored `active` value is absent or names a provider.
 *
 * @param {unknown} candidate - A stored `active` value.
 * @returns {boolean} `true` when it is `undefined` or a known provider name.
 */
function isOptionalProvider(candidate) {
  return candidate === undefined || LLM_PROVIDERS.includes(candidate)
}
