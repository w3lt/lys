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
  /**
   * Whether Lys loads and unloads the provider's models; only LM Studio's.
   * Ollama loads a model when a request names it, and Groq's are hosted.
   */
  readonly managesModelLoading: boolean
}

/** Name of each provider. */
export const LLM_PROVIDER_NAMES = Object.freeze({
  lmStudio: "LM Studio",
  ollama: "Ollama",
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
 * @returns The active provider, its name, how and where it is reached, with
 * a provider's default address while none is saved, and whether Lys manages
 * its model loading.
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
          providers.lmStudio.address ?? DEFAULT_PROVIDER_ADDRESSES.lmStudio,
        managesModelLoading: true
      }
    case "ollama":
      return {
        provider: "ollama",
        name: LLM_PROVIDER_NAMES.ollama,
        access: providers.ollama.mode === "local" ? "address" : "key",
        location:
          providers.ollama.mode === "local"
            ? (providers.ollama.address ?? DEFAULT_PROVIDER_ADDRESSES.ollama)
            : OLLAMA_CLOUD_API_HOST,
        managesModelLoading: false
      }
    case "groq":
      return {
        provider: "groq",
        name: LLM_PROVIDER_NAMES.groq,
        access: "key",
        location: GROQ_API_HOST,
        managesModelLoading: false
      }
  }
}
