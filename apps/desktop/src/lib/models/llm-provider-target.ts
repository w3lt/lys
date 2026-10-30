import {
  GROQ_API_HOST,
  LMSTUDIO_HOST,
  LMSTUDIO_PORT,
  OLLAMA_CLOUD_API_HOST,
  OLLAMA_HOST,
  OLLAMA_PORT
} from "@lys/protocol"
import type { LlmProvider } from "@lys/share"
import type { ProvidersSettings } from "@/lib/store/settings"

/** Provider reached at a server address the person may set. */
export type AddressedLlmProvider = "lmStudio" | "ollama"

/** Provider reached at a hosted API with a key the person saves. */
export type KeyedLlmProvider = "ollamaCloud" | "groq"

/** The provider the saved choice makes the backend connect to. */
export type LlmProviderTarget = {
  /** Active provider. */
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

/** Name of each provider. */
export const LLM_PROVIDER_NAMES = Object.freeze({
  lmStudio: "LM Studio",
  ollama: "Ollama",
  ollamaCloud: "Ollama Cloud",
  groq: "Groq"
} satisfies Readonly<Record<LlmProvider, string>>)

/** Address each addressed provider uses while none is saved. */
export const DEFAULT_PROVIDER_ADDRESSES = Object.freeze({
  lmStudio: `${LMSTUDIO_HOST}:${LMSTUDIO_PORT}`,
  ollama: `${OLLAMA_HOST}:${OLLAMA_PORT}`
} satisfies Readonly<Record<AddressedLlmProvider, string>>)

/**
 * Describes the provider the saved choice makes the backend connect to.
 *
 * @param providers - Saved provider choice and addresses.
 * @returns The active provider, its name, and how and where it is reached,
 * with a provider's default address while none is saved.
 */
export function describeLlmProviderTarget(
  providers: ProvidersSettings
): LlmProviderTarget {
  switch (providers.active) {
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
