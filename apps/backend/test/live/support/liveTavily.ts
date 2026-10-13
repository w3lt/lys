import { tavilyApiKeySchema, type TavilyApiKey } from "@lys/share"

/**
 * Environment variable that supplies the real Tavily API key of a live run;
 * the only input the live suite reads from the environment.
 */
export const LIVE_TAVILY_API_KEY_VARIABLE = "LYS_TEST_TAVILY_API_KEY"

/**
 * Well-formed key that Tavily never issued, for the case that expects a
 * rejection; not a secret.
 */
export const UNKNOWN_TAVILY_API_KEY = tavilyApiKeySchema.parse(
  "tvly-lys-live-test-unknown-key"
)

/**
 * Gets the real Tavily API key of a live run from the environment.
 *
 * @returns The key; a secret, so no assertion may print it.
 * @throws If {@link LIVE_TAVILY_API_KEY_VARIABLE} is unset or does not hold a
 * well-formed key. The message names the variable and never its value.
 */
export function getLiveTavilyApiKey(): TavilyApiKey {
  const parsed = tavilyApiKeySchema.safeParse(
    process.env[LIVE_TAVILY_API_KEY_VARIABLE]
  )
  if (!parsed.success) {
    throw new Error(
      `${LIVE_TAVILY_API_KEY_VARIABLE} must hold a real Tavily API key: the live tests call the Tavily API with it.`
    )
  }
  return parsed.data
}
