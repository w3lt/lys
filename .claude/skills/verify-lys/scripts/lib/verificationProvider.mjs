/**
 * What the verification provider answers, shared by the fake and the
 * journeys that check what Lys made of it.
 *
 * @remarks The fake stands in for a local Ollama server at the backend's
 * provider boundary: the backend's HTTP client, its settings reader, and
 * its reply model are the real code. The reply is sent one word at a time
 * with a pause between words, so a streamed reply is observably different
 * from one that arrived whole.
 */

/** Model name the fake lists, in Ollama's `name:tag` form. */
export const VERIFICATION_MODEL_NAME = "lys-verify:latest"

/** Context window the fake reports for its model, in tokens. */
export const VERIFICATION_CONTEXT_LENGTH = 8192

/** Text of every streamed reply. */
export const VERIFICATION_REPLY_TEXT =
  "Lys verification reply: the quick brown fox jumps over the lazy dog while every word of this sentence arrives on its own, so a streamed reply can be told apart from one that came all at once."

/** Pause between two streamed words, in milliseconds. */
export const VERIFICATION_TOKEN_INTERVAL_MS = 120

/** Title the fake generates for every conversation. */
export const VERIFICATION_TITLE = "Verification streaming chat"

/**
 * Splits the reply into the fragments the fake streams, each word with its
 * following space.
 *
 * @returns {string[]} The fragments, which concatenate to the reply text.
 */
export function listReplyFragments() {
  return VERIFICATION_REPLY_TEXT.match(/\S+\s*/g) ?? []
}

/**
 * Reduces whitespace runs to one space and trims, so rendered text can be
 * compared with the reply text.
 *
 * @param {string} text - Rendered or streamed text.
 * @returns {string} The normalised text.
 */
export function formatComparableText(text) {
  return text.replaceAll(/\s+/g, " ").trim()
}
