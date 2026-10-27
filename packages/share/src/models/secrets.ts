import * as z from "zod"

/**
 * Most characters an API key may have, inclusive.
 *
 * @remarks The settings file never holds a longer key: the desktop host
 * checks the same limit, in its own copy of this rule, when it loads the
 * file. Raising it changes which settings files load and requires a
 * coordinated desktop and backend release.
 */
const MAXIMUM_API_KEY_LENGTH = 256

/** Finds a text made only of visible ASCII characters, `!` through `~`. */
const VISIBLE_ASCII_PATTERN = /^[!-~]+$/

/**
 * Validates the text of an API key: 1 to {@link MAXIMUM_API_KEY_LENGTH}
 * visible ASCII characters, so it holds no space, line break, or other
 * character that could split or extend the HTTP header it is sent in.
 *
 * @remarks The key is opaque: parsing never trims or changes it, and no
 * vendor prefix is required. Each service brands it with its own type.
 */
const apiKeyTextSchema = z
  .string()
  .min(1)
  .max(MAXIMUM_API_KEY_LENGTH)
  .regex(VISIBLE_ASCII_PATTERN)

/**
 * Validates a Tavily API key under the shared API key rule.
 *
 * @remarks The output is branded, so a checked key cannot stand in for
 * other text or another service's key.
 */
export const tavilyApiKeySchema = apiKeyTextSchema.brand<"TavilyApiKey">()

/** Tavily API key that passed {@link tavilyApiKeySchema}; a secret. */
export type TavilyApiKey = z.infer<typeof tavilyApiKeySchema>

/**
 * Validates an Ollama cloud API key under the shared API key rule.
 *
 * @remarks The output is branded, so a checked key cannot stand in for
 * other text or another service's key.
 */
export const ollamaApiKeySchema = apiKeyTextSchema.brand<"OllamaApiKey">()

/** Ollama cloud API key that passed {@link ollamaApiKeySchema}; a secret. */
export type OllamaApiKey = z.infer<typeof ollamaApiKeySchema>

/**
 * Validates a Groq API key under the shared API key rule.
 *
 * @remarks The output is branded, so a checked key cannot stand in for
 * other text or another service's key.
 */
export const groqApiKeySchema = apiKeyTextSchema.brand<"GroqApiKey">()

/** Groq API key that passed {@link groqApiKeySchema}; a secret. */
export type GroqApiKey = z.infer<typeof groqApiKeySchema>
