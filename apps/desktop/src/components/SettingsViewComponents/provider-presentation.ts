import {
  groqApiKeySchema,
  ollamaApiKeySchema,
  providerAddressSchema,
  type GroqApiKey,
  type LlmProvider,
  type OllamaApiKey,
  type ProviderAddress
} from "@lys/share"

import groqLogoUrl from "@/assets/providers/groq.svg"
import lmStudioLogoUrl from "@/assets/providers/lm-studio.svg"
import ollamaLogoUrl from "@/assets/providers/ollama.svg"
import {
  DEFAULT_PROVIDER_ADDRESSES,
  LLM_PROVIDER_NAMES,
  type AddressedLlmProvider,
  type KeyedLlmProvider
} from "@/lib/models/llm-provider-target"
import type { LmStudioStatus } from "@/lib/store/lm-studio-status"
import type {
  ProviderApiKeyChange,
  ProviderSettingsSaveState
} from "@/lib/store/provider-settings"
import type { ProvidersSettings, SecretsSettings } from "@/lib/store/settings"

import { formatMaskedApiKey, type SecretTone } from "./secrets-presentation"

/**
 * A card of the Providers pane. Ollama's card presents both Ollama providers,
 * a local server and Ollama Cloud, and switches between them.
 */
export type ProviderCardKind = "lmStudio" | "ollama" | "groq"

/** Provider an Ollama card's Local or Cloud button makes active. */
export type OllamaLlmProvider = "ollama" | "ollamaCloud"

/** What a provider card shows of its provider. */
export type ProviderDescription = {
  /** Provider's name. */
  readonly name: string
  /** One line on what the provider is and where requests go. */
  readonly blurb: string
  /** Bundled logo, served by the app. */
  readonly logoUrl: string
}

/** How the active provider is reached, which decides the card's form. */
export type ProviderAccessKind =
  | {
      /** A server at an address. */
      readonly kind: "address"
      /** Provider whose address the form edits. */
      readonly provider: AddressedLlmProvider
    }
  | {
      /** A hosted API with a key. */
      readonly kind: "key"
      /** Provider whose key the form edits. */
      readonly provider: KeyedLlmProvider
    }

/** State shown on a provider card's badge. */
export type ProviderBadge = {
  /** Lowercase badge text. */
  readonly label:
    | "standby"
    | "needs key"
    | "unknown"
    | "connecting"
    | "connected"
    | "unreachable"
  /** Tone of the badge's dot. */
  readonly tone: SecretTone
}

/** The person's edit of a text field: an address or a key. */
export type ProviderFieldDraft =
  | { readonly status: "unedited" }
  | {
      readonly status: "edited"
      /** Text in the field. */
      readonly text: string
    }

/** Outcome of reading the address field's text. */
export type ProviderAddressDraftParse =
  | {
      /** The text names an address other than the saved one. */
      readonly status: "changed"
      /** Address to save, or null to use the provider's default. */
      readonly address: ProviderAddress | null
    }
  | { readonly status: "unchanged" }
  | { readonly status: "invalid" }

/** Outcome of reading the key field's text. */
export type ProviderKeyDraftParse =
  | {
      /** The text is a valid key other than the saved one. */
      readonly status: "changed"
      /** Key to save. */
      readonly change: ProviderApiKeyChange
    }
  | { readonly status: "unchanged" }
  | { readonly status: "invalid" }

/** Facts the active card's status line describes. */
export type ProviderStatusInput = {
  /** How the active provider is reached. */
  readonly access: ProviderAccessKind
  /** Saved provider choice and addresses. */
  readonly providers: ProvidersSettings
  /** Saved keys. */
  readonly secrets: SecretsSettings
  /** Latest published connection status of the backend's provider. */
  readonly status: LmStudioStatus
  /** Latest provider save. */
  readonly saveState: ProviderSettingsSaveState
  /** The person's edit of the card's field. */
  readonly draft: ProviderFieldDraft
}

/** One line under the active card's form. */
export type ProviderMessage = {
  /** Text of the line. */
  readonly text: string
  /** Tone of the line. */
  readonly tone: SecretTone
}

/** Field state while the person has not edited it. */
export const UNEDITED_PROVIDER_DRAFT: ProviderFieldDraft = Object.freeze({
  status: "unedited"
})

/** Cards in the order the pane lists them. */
export const PROVIDER_CARD_ORDER: readonly ProviderCardKind[] = Object.freeze([
  "lmStudio",
  "ollama",
  "groq"
])

/** Card that presents each provider. */
export const PROVIDER_CARDS = Object.freeze({
  lmStudio: "lmStudio",
  ollama: "ollama",
  ollamaCloud: "ollama",
  groq: "groq"
} satisfies Readonly<Record<LlmProvider, ProviderCardKind>>)

/**
 * Provider that picking each card makes active; picking Ollama's card makes
 * the local server active, and its Cloud button switches to Ollama Cloud.
 */
export const PROVIDER_CARD_PROVIDERS = Object.freeze({
  lmStudio: "lmStudio",
  ollama: "ollama",
  groq: "groq"
} satisfies Readonly<Record<ProviderCardKind, LlmProvider>>)

/** Ollama's providers, in the order the card's buttons show them. */
export const OLLAMA_PROVIDERS: readonly OllamaLlmProvider[] = Object.freeze([
  "ollama",
  "ollamaCloud"
])

/** What each provider card shows, by card. */
export const PROVIDER_DESCRIPTIONS = Object.freeze({
  lmStudio: Object.freeze({
    name: LLM_PROVIDER_NAMES.lmStudio,
    blurb:
      "Runs models on a machine you choose. Lys loads and unloads them for you.",
    logoUrl: lmStudioLogoUrl
  }),
  ollama: Object.freeze({
    name: LLM_PROVIDER_NAMES.ollama,
    blurb:
      "Runs open models on your machine or in Ollama Cloud, loading each when a message names it.",
    logoUrl: ollamaLogoUrl
  }),
  groq: Object.freeze({
    name: LLM_PROVIDER_NAMES.groq,
    blurb:
      "Hosted models on Groq's chips. Your conversations go to Groq to be answered.",
    logoUrl: groqLogoUrl
  })
} satisfies Readonly<Record<ProviderCardKind, ProviderDescription>>)

/** Page where a person creates each keyed provider's API key. */
export const PROVIDER_KEY_PAGE_URLS = Object.freeze({
  ollamaCloud: "https://ollama.com/settings/keys",
  groq: "https://console.groq.com/keys"
} satisfies Readonly<Record<KeyedLlmProvider, string>>)

/** Placeholder of each keyed provider's field while no key is saved. */
const KEY_PLACEHOLDERS = Object.freeze({
  ollamaCloud: "paste your Ollama key",
  groq: "gsk_…"
} satisfies Readonly<Record<KeyedLlmProvider, string>>)

/** Text of the Ollama card's buttons, by the provider each makes active. */
export const OLLAMA_PROVIDER_LABELS = Object.freeze({
  ollama: "Local",
  ollamaCloud: "Cloud"
} satisfies Readonly<Record<OllamaLlmProvider, string>>)

/** Note above the Ollama card's buttons, by active Ollama provider. */
export const OLLAMA_PROVIDER_NOTES = Object.freeze({
  ollama:
    "A server on this machine or your network. Conversations stay where it runs.",
  ollamaCloud:
    "Ollama's hosted models. Conversations go to Ollama, with your key."
} satisfies Readonly<Record<OllamaLlmProvider, string>>)

/** Line of a draft that changed and can be saved. */
const UNSAVED_MESSAGE: ProviderMessage = Object.freeze({
  text: "unsaved · enter to save, esc to discard",
  tone: "attention"
})

/** Line of an address draft that is not an address. */
const INVALID_ADDRESS_MESSAGE: ProviderMessage = Object.freeze({
  text: "not an address: use host:port, such as 127.0.0.1:1234",
  tone: "danger"
})

/**
 * Formats the tag after a card's name.
 *
 * @param card - Card the tag belongs to.
 * @param providers - Saved provider choice, for which Ollama provider is
 * active.
 * @returns `local` for LM Studio, `cloud` while Ollama Cloud is active and
 * `local` otherwise for Ollama, and `cloud` for Groq.
 */
export function formatProviderModeTag(
  card: ProviderCardKind,
  providers: ProvidersSettings
): string {
  switch (card) {
    case "lmStudio":
      return "local"
    case "ollama":
      return providers.active === "ollamaCloud" ? "cloud" : "local"
    case "groq":
      return "cloud"
  }
}

/**
 * Finds how a provider is reached.
 *
 * @param provider - Provider the card configures.
 * @returns An address for LM Studio and a local Ollama server, a key for
 * Ollama Cloud and Groq.
 */
export function findProviderAccessKind(
  provider: LlmProvider
): ProviderAccessKind {
  switch (provider) {
    case "lmStudio":
    case "ollama":
      return { kind: "address", provider }
    case "ollamaCloud":
    case "groq":
      return { kind: "key", provider }
  }
}

/**
 * Finds the address an addressed provider saved.
 *
 * @param provider - Addressed provider.
 * @param providers - Saved provider choice.
 * @returns The saved address, or null while the provider uses its default.
 */
export function findSavedProviderAddress(
  provider: AddressedLlmProvider,
  providers: ProvidersSettings
): ProviderAddress | null {
  return provider === "lmStudio"
    ? providers.lmStudio.address
    : providers.ollama.address
}

/**
 * Finds the key a keyed provider saved.
 *
 * @param provider - Keyed provider.
 * @param secrets - Saved keys.
 * @returns The saved key, or null; a secret.
 */
export function findSavedProviderApiKey(
  provider: KeyedLlmProvider,
  secrets: SecretsSettings
): OllamaApiKey | GroqApiKey | null {
  return provider === "ollamaCloud" ? secrets.ollamaApiKey : secrets.groqApiKey
}

/**
 * Builds the provider choice with one provider's address replaced.
 *
 * @param providers - Saved provider choice.
 * @param provider - Addressed provider.
 * @param address - New address, or null for the default.
 * @returns A new choice; the rest is unchanged.
 */
export function buildProvidersWithAddress(
  providers: ProvidersSettings,
  provider: AddressedLlmProvider,
  address: ProviderAddress | null
): ProvidersSettings {
  return provider === "lmStudio"
    ? { ...providers, lmStudio: { address } }
    : { ...providers, ollama: { address } }
}

/**
 * Formats the address field's placeholder.
 *
 * @param provider - Addressed provider.
 * @param providers - Saved provider choice.
 * @returns The saved address, or the default while none is saved.
 */
export function formatProviderAddressPlaceholder(
  provider: AddressedLlmProvider,
  providers: ProvidersSettings
): string {
  return (
    findSavedProviderAddress(provider, providers) ??
    DEFAULT_PROVIDER_ADDRESSES[provider]
  )
}

/**
 * Reads the address field's text as an address to save.
 *
 * @param draft - The person's edit.
 * @param saved - Saved address, or null for the default.
 * @returns `changed` with the address, or with null for empty text while an
 * address is saved; `unchanged` when there is nothing to save; or `invalid`.
 * Surrounding whitespace is the only change made to the text.
 */
export function parseProviderAddressDraft(
  draft: ProviderFieldDraft,
  saved: ProviderAddress | null
): ProviderAddressDraftParse {
  if (draft.status === "unedited") return { status: "unchanged" }
  const trimmed = draft.text.trim()
  if (trimmed === "") {
    return saved === null
      ? { status: "unchanged" }
      : { status: "changed", address: null }
  }
  if (trimmed === saved) return { status: "unchanged" }
  const parsed = providerAddressSchema.safeParse(trimmed)
  return parsed.success
    ? { status: "changed", address: parsed.data }
    : { status: "invalid" }
}

/**
 * Formats the key field's placeholder.
 *
 * @param provider - Keyed provider.
 * @param secrets - Saved keys.
 * @returns The masked saved key, or an example while none is saved.
 */
export function formatProviderKeyPlaceholder(
  provider: KeyedLlmProvider,
  secrets: SecretsSettings
): string {
  const saved = findSavedProviderApiKey(provider, secrets)
  return saved === null ? KEY_PLACEHOLDERS[provider] : formatMaskedApiKey(saved)
}

/**
 * Calculates the text in the key field.
 *
 * @param draft - The person's edit.
 * @param isKeyShown - Whether the person asked to see the key.
 * @param saved - Saved key, or null.
 * @returns The edited text; otherwise the saved key while it is shown; empty
 * otherwise, so the masked placeholder shows.
 */
export function calculateProviderKeyFieldValue(
  draft: ProviderFieldDraft,
  isKeyShown: boolean,
  saved: string | null
): string {
  if (draft.status === "edited") return draft.text
  return isKeyShown && saved !== null ? saved : ""
}

/**
 * Reads the key field's text as a key to save.
 *
 * @param provider - Keyed provider.
 * @param draft - The person's edit.
 * @param secrets - Saved keys.
 * @returns `changed` with the key when it is valid and differs from the
 * saved one, `unchanged` when there is nothing to save, or `invalid`.
 * Surrounding whitespace is the only change made to the text.
 */
export function parseProviderKeyDraft(
  provider: KeyedLlmProvider,
  draft: ProviderFieldDraft,
  secrets: SecretsSettings
): ProviderKeyDraftParse {
  if (draft.status === "unedited") return { status: "unchanged" }
  const trimmed = draft.text.trim()
  if (trimmed === "" || trimmed === findSavedProviderApiKey(provider, secrets))
    return { status: "unchanged" }
  if (provider === "ollamaCloud") {
    const parsed = ollamaApiKeySchema.safeParse(trimmed)
    return parsed.success
      ? { status: "changed", change: { provider, apiKey: parsed.data } }
      : { status: "invalid" }
  }
  const parsed = groqApiKeySchema.safeParse(trimmed)
  return parsed.success
    ? { status: "changed", change: { provider, apiKey: parsed.data } }
    : { status: "invalid" }
}

/**
 * Answers whether the active provider needs a key that is not saved.
 *
 * @param access - How the active provider is reached.
 * @param secrets - Saved keys.
 * @returns True for a keyed provider without a saved key.
 */
function isProviderKeyMissing(
  access: ProviderAccessKind,
  secrets: SecretsSettings
): boolean {
  return (
    access.kind === "key" &&
    findSavedProviderApiKey(access.provider, secrets) === null
  )
}

/**
 * Calculates a provider card's badge.
 *
 * @param card - Card the badge belongs to.
 * @param providers - Saved provider choice.
 * @param secrets - Saved keys.
 * @param status - Latest published connection status.
 * @returns `standby` for a card that does not present the active provider;
 * `needs key` for the active provider without its key; otherwise the
 * connection status, with `unknown` while the backend is not running.
 */
export function calculateProviderBadge(
  card: ProviderCardKind,
  providers: ProvidersSettings,
  secrets: SecretsSettings,
  status: LmStudioStatus
): ProviderBadge {
  if (PROVIDER_CARDS[providers.active] !== card)
    return { label: "standby", tone: "muted" }
  if (isProviderKeyMissing(findProviderAccessKind(providers.active), secrets))
    return { label: "needs key", tone: "attention" }
  switch (status) {
    case "unknown":
      return { label: "unknown", tone: "muted" }
    case "connecting":
      return { label: "connecting", tone: "attention" }
    case "connected":
      return { label: "connected", tone: "success" }
    case "unreachable":
      return { label: "unreachable", tone: "danger" }
  }
}

/**
 * Formats what the active connection status means for one provider.
 *
 * @param access - How the active provider is reached.
 * @param providers - Saved provider choice, for the address.
 * @param status - Latest published connection status.
 * @returns The line for that status.
 */
function formatConnectionMessage(
  access: ProviderAccessKind,
  providers: ProvidersSettings,
  status: LmStudioStatus
): ProviderMessage {
  const name = LLM_PROVIDER_NAMES[access.provider]
  const where =
    access.kind === "address"
      ? formatProviderAddressPlaceholder(access.provider, providers)
      : undefined
  switch (status) {
    case "unknown":
      return {
        text: `the backend isn't running, so Lys can't reach ${name} yet`,
        tone: "muted"
      }
    case "connecting":
      return { text: `connecting to ${name}…`, tone: "pending" }
    case "connected":
      return {
        text:
          where === undefined
            ? `connected · requests go to ${name}`
            : `connected · ${where}`,
        tone: "success"
      }
    case "unreachable":
      return {
        text:
          where === undefined
            ? `${name} didn't answer with this key · check the key and your network`
            : `${name} is not reachable at ${where} · start it, or check the address`,
        tone: "danger"
      }
  }
}

/**
 * Formats what an edit of the card's field means, or undefined when it has
 * nothing to say.
 *
 * @param input - Facts the line describes.
 * @returns The line of an invalid or unsaved edit, or undefined.
 */
function formatDraftMessage(
  input: ProviderStatusInput
): ProviderMessage | undefined {
  const { access, draft } = input
  if (access.kind === "address") {
    const parsed = parseProviderAddressDraft(
      draft,
      findSavedProviderAddress(access.provider, input.providers)
    )
    if (parsed.status === "invalid") return INVALID_ADDRESS_MESSAGE
    return parsed.status === "changed" ? UNSAVED_MESSAGE : undefined
  }
  const parsed = parseProviderKeyDraft(access.provider, draft, input.secrets)
  if (parsed.status === "invalid") {
    const name = LLM_PROVIDER_NAMES[access.provider]
    return {
      text: `not a valid key: paste it exactly as ${name} shows it, without spaces`,
      tone: "danger"
    }
  }
  return parsed.status === "changed" ? UNSAVED_MESSAGE : undefined
}

/**
 * Formats the line under the active card's form.
 *
 * @param input - Access, saved settings, connection, save, and edit.
 * @returns, in order of precedence: what an edit means; a running or failed
 * save; a missing key; then the connection status.
 */
export function formatProviderMessage(
  input: ProviderStatusInput
): ProviderMessage {
  const draftMessage = formatDraftMessage(input)
  if (draftMessage !== undefined) return draftMessage
  if (input.saveState.status === "saving")
    return { text: "saving…", tone: "pending" }
  if (input.saveState.status === "failed")
    return { text: input.saveState.error, tone: "danger" }
  if (isProviderKeyMissing(input.access, input.secrets)) {
    const name = LLM_PROVIDER_NAMES[input.access.provider]
    return {
      text: `No key yet. Lys can't reach ${name} until there is one.`,
      tone: "attention"
    }
  }
  return formatConnectionMessage(input.access, input.providers, input.status)
}
