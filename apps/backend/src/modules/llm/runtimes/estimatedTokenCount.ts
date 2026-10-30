/**
 * UTF-8 bytes counted as one token when a provider offers no tokenizer.
 *
 * @remarks Real tokenizers average about four bytes of English prose per
 * token and fewer for code or other scripts; counting three bytes per token
 * overestimates most text, so a context that fits by this count rarely
 * overflows the provider's window. A text in a script whose characters take
 * three bytes, such as Chinese, counts as about one token per character.
 */
const ESTIMATED_BYTES_PER_TOKEN = 3

/**
 * Estimates a text's token count for a provider that offers no tokenizer.
 *
 * @param text - Text to count on its own.
 * @returns The UTF-8 byte length divided by
 * {@link ESTIMATED_BYTES_PER_TOKEN}, rounded up; a whole number ≥ 0.
 */
export function estimateTextTokenCount(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / ESTIMATED_BYTES_PER_TOKEN)
}
