import {
  GROQ_API_HOST,
  LMSTUDIO_HOST,
  LMSTUDIO_PORT,
  OLLAMA_CLOUD_API_HOST,
  OLLAMA_HOST,
  OLLAMA_PORT
} from "@lys/protocol"
import {
  providerAddressSchema,
  type GroqApiKey,
  type OllamaApiKey,
  type ProviderAddress
} from "@lys/share"

/** LM Studio's address while the person has saved none. */
export const DEFAULT_LM_STUDIO_ADDRESS: ProviderAddress =
  providerAddressSchema.parse(`${LMSTUDIO_HOST}:${LMSTUDIO_PORT}`)

/** A local Ollama server's address while the person has saved none. */
export const DEFAULT_OLLAMA_ADDRESS: ProviderAddress =
  providerAddressSchema.parse(`${OLLAMA_HOST}:${OLLAMA_PORT}`)

/**
 * How the backend reaches the provider every request goes to, resolved from
 * the person's saved settings.
 *
 * @remarks Each variant holds exactly what reaching its provider needs: a
 * server address for a provider the person runs, an API key for a hosted
 * one. The keys are secrets: the value is never logged or sent anywhere but
 * its provider's host.
 */
export type LlmProviderAccess =
  | Readonly<{
      /** LM Studio, reached over its SDK and its OpenAI-compatible API. */
      provider: "lmStudio"
      /** LM Studio's server. */
      address: ProviderAddress
    }>
  | Readonly<{
      /**
       * A local Ollama server the person runs, reached over plain HTTP with
       * Ollama's native and OpenAI-compatible APIs.
       */
      provider: "ollama"
      /** The Ollama server. */
      address: ProviderAddress
    }>
  | Readonly<{
      /**
       * Ollama Cloud at {@link OLLAMA_CLOUD_API_HOST}, reached with the same
       * APIs as a local server.
       */
      provider: "ollamaCloud"
      /** Key sent as a bearer token with every request; a secret. */
      apiKey: OllamaApiKey
    }>
  | Readonly<{
      /** Groq's API at {@link GROQ_API_HOST}. */
      provider: "groq"
      /** Key sent as a bearer token with every request; a secret. */
      apiKey: GroqApiKey
    }>

/**
 * OpenAI-compatible chat endpoint of one provider.
 *
 * @remarks The API key is a secret, sent only to the base URL's host.
 */
export type LlmChatEndpoint = Readonly<{
  /** Base URL that chat completion paths are appended to. */
  baseUrl: string
  /** Bearer credential, or undefined for a server that takes none. */
  apiKey: string | undefined
  /**
   * Request field the endpoint reads the reply ceiling from: `max_tokens`
   * for Ollama, whose OpenAI-compatible API ignores `max_completion_tokens`,
   * and `max_completion_tokens` for the other providers.
   */
  replyCeilingField: "max_completion_tokens" | "max_tokens"
}>

/**
 * Finds the OpenAI-compatible chat endpoint of a provider.
 *
 * @param access - How the provider is reached.
 * @returns `http://<address>/v1` for LM Studio and a local Ollama server,
 * `https://ollama.com/v1` with the key for Ollama Cloud, and
 * `https://api.groq.com/openai/v1` with the key for Groq; both Ollama
 * endpoints read the reply ceiling from `max_tokens`.
 */
export function buildLlmChatEndpoint(
  access: LlmProviderAccess
): LlmChatEndpoint {
  switch (access.provider) {
    case "lmStudio":
      return Object.freeze({
        baseUrl: `http://${access.address}/v1`,
        apiKey: undefined,
        replyCeilingField: "max_completion_tokens"
      })
    case "ollama":
      return Object.freeze({
        baseUrl: `http://${access.address}/v1`,
        apiKey: undefined,
        replyCeilingField: "max_tokens"
      })
    case "ollamaCloud":
      return Object.freeze({
        baseUrl: `https://${OLLAMA_CLOUD_API_HOST}/v1`,
        apiKey: access.apiKey,
        replyCeilingField: "max_tokens"
      })
    case "groq":
      return Object.freeze({
        baseUrl: `https://${GROQ_API_HOST}/openai/v1`,
        apiKey: access.apiKey,
        replyCeilingField: "max_completion_tokens"
      })
  }
}

/**
 * Answers whether two accesses reach the same provider in the same way.
 *
 * @param left - First access.
 * @param right - Second access.
 * @returns True when the provider, address, and key are all equal, so
 * a runtime acquired for one serves the other.
 */
export function isSameLlmProviderAccess(
  left: LlmProviderAccess,
  right: LlmProviderAccess
): boolean {
  const leftChat = buildLlmChatEndpoint(left)
  const rightChat = buildLlmChatEndpoint(right)
  return (
    left.provider === right.provider &&
    leftChat.baseUrl === rightChat.baseUrl &&
    leftChat.apiKey === rightChat.apiKey
  )
}
