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

/**
 * Most characters, counted as Unicode code points, an email password may
 * have, inclusive.
 *
 * @remarks The settings file never holds a longer password: the desktop
 * host checks the same limit, in its own copy of this rule, when it loads
 * the file, and the email server checks it again, in a third copy, before
 * it uses the account. Raising it changes which settings files load and
 * which accounts the email server accepts, and requires a coordinated
 * release of the desktop host, the backend, and the email server.
 */
export const MAXIMUM_EMAIL_PASSWORD_LENGTH = 1024

/**
 * Answers whether a text follows the email password rule: 1 to
 * {@link MAXIMUM_EMAIL_PASSWORD_LENGTH} code points, no control character,
 * and no lone surrogate.
 *
 * @param value - Text to inspect, as typed.
 * @returns True when the text is a valid password.
 */
function isEmailPassword(value: string): boolean {
  /**
   * Finds a control character (Unicode general category Cc), such as a line
   * break.
   */
  const controlCharacterPattern = /\p{Cc}/u

  /** Finds a lone surrogate: half of a UTF-16 pair without the other half. */
  const loneSurrogatePattern = /\p{Cs}/u

  const length = [...value].length

  return (
    length >= 1 &&
    length <= MAXIMUM_EMAIL_PASSWORD_LENGTH &&
    !controlCharacterPattern.test(value) &&
    !loneSurrogatePattern.test(value)
  )
}

/**
 * Validates the password, or app password, an email account signs in with,
 * as the person typed it.
 *
 * @remarks Spaces are kept, because some providers show app passwords in
 * spaced groups and accept them either way; parsing never trims or changes
 * the password. The output is branded, so a checked password cannot stand
 * in for other text.
 */
export const emailPasswordSchema = z
  .string()
  .refine(
    isEmailPassword,
    `A password is 1 to ${MAXIMUM_EMAIL_PASSWORD_LENGTH} characters, without line breaks or other control characters.`
  )
  .brand<"EmailPassword">()

/** Email password that passed {@link emailPasswordSchema}; a secret. */
export type EmailPassword = z.infer<typeof emailPasswordSchema>
