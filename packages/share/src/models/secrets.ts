import * as z from "zod"

/**
 * Most characters a Tavily API key may have, inclusive.
 *
 * @remarks The settings file never holds a longer key: the desktop host
 * checks the same limit, in its own copy of this rule, when it loads the
 * file. Raising it changes which settings files load and requires a
 * coordinated desktop and backend release.
 */
const MAXIMUM_TAVILY_API_KEY_LENGTH = 256

/** Finds a text made only of visible ASCII characters, `!` through `~`. */
const VISIBLE_ASCII_PATTERN = /^[!-~]+$/

/**
 * Validates a Tavily API key: 1 to {@link MAXIMUM_TAVILY_API_KEY_LENGTH}
 * visible ASCII characters, so it holds no space, line break, or other
 * character that could split or extend the HTTP header it is sent in.
 *
 * @remarks The key is opaque: parsing never trims or changes it, and no
 * Tavily prefix is required. The output is branded, so a checked key cannot
 * stand in for other text.
 */
export const tavilyApiKeySchema = z
  .string()
  .min(1)
  .max(MAXIMUM_TAVILY_API_KEY_LENGTH)
  .regex(VISIBLE_ASCII_PATTERN)
  .brand<"TavilyApiKey">()

/** Tavily API key that passed {@link tavilyApiKeySchema}; a secret. */
export type TavilyApiKey = z.infer<typeof tavilyApiKeySchema>
