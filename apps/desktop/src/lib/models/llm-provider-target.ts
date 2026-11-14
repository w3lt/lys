import {
  GROQ_API_HOST,
  LMSTUDIO_HOST,
  LMSTUDIO_PORT,
  OLLAMA_CLOUD_API_HOST,
  OLLAMA_HOST,
  OLLAMA_PORT
} from "@lys/protocol"
import {
  LLM_PROVIDER_NAMES,
  type GroqApiKey,
  type LlmProvider,
  type OllamaApiKey
} from "@lys/share"
import type { ProvidersSettings, SecretsSettings } from "@/lib/store/settings"

/** Provider reached at a server address the person may set. */
export type AddressedLlmProvider = "lmStudio" | "ollama"

/** Provider reached at a hosted API with a key the person saves. */
export type KeyedLlmProvider = "ollamaCloud" | "groq"

/** A provider, and where the saved settings make the backend reach it. */
export type LlmProviderTarget = {
  /** The provider. */
  readonly provider: LlmProvider
  /** Provider's name. */
  readonly name: string
  /**
   * How the provider is reached: a server at an address, or a hosted API
   * with a key.
   */
  readonly access: "address" | "key"
  /** Where requests go: the server's address, or the hosted API's host. */
  readonly location: string
}

/** Address each addressed provider uses while none is saved. */
export const DEFAULT_PROVIDER_ADDRESSES = Object.freeze({
  lmStudio: `${LMSTUDIO_HOST}:${LMSTUDIO_PORT}`,
  ollama: `${OLLAMA_HOST}:${OLLAMA_PORT}`
} satisfies Readonly<Record<AddressedLlmProvider, string>>)

/**
 * Describes where the saved settings make the backend reach a provider.
 *
 * @param provider - Provider to describe, whether on or off.
 * @param providers - Saved providers group, which holds the addresses.
 * @returns The provider, its name, and how and where it is reached, with a
 * provider's default address while none is saved.
 */
export function describeLlmProviderTarget(
  provider: LlmProvider,
  providers: ProvidersSettings
): LlmProviderTarget {
  switch (provider) {
    case "lmStudio":
      return {
        provider: "lmStudio",
        name: LLM_PROVIDER_NAMES.lmStudio,
        access: "address",
        location:
          providers.lmStudio.address ?? DEFAULT_PROVIDER_ADDRESSES.lmStudio
      }
    case "ollama":
      return {
        provider: "ollama",
        name: LLM_PROVIDER_NAMES.ollama,
        access: "address",
        location: providers.ollama.address ?? DEFAULT_PROVIDER_ADDRESSES.ollama
      }
    case "ollamaCloud":
      return {
        provider: "ollamaCloud",
        name: LLM_PROVIDER_NAMES.ollamaCloud,
        access: "key",
        location: OLLAMA_CLOUD_API_HOST
      }
    case "groq":
      return {
        provider: "groq",
        name: LLM_PROVIDER_NAMES.groq,
        access: "key",
        location: GROQ_API_HOST
      }
  }
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
 * Answers whether a provider needs a key and none is saved.
 *
 * @param provider - Provider to check, whether on or off.
 * @param secrets - Saved keys.
 * @returns True for Ollama Cloud or Groq without a saved key; false for a
 * provider reached at an address, which needs none.
 * @remarks This is the one rule behind every "needs a key" the desktop
 * shows: a turned-on provider that needs a key it lacks is shown as needing
 * one, whatever the backend reports of its connection.
 */
export function isLlmProviderKeyMissing(
  provider: LlmProvider,
  secrets: SecretsSettings
): boolean {
  switch (provider) {
    case "lmStudio":
    case "ollama":
      return false
    case "ollamaCloud":
    case "groq":
      return findSavedProviderApiKey(provider, secrets) === null
  }
}
