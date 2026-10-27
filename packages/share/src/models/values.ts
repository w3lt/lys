/**
 * Answers whether every value in a list appears once.
 *
 * @param values - Values to inspect, compared exactly, such as tool names.
 * @returns True when no value repeats.
 */
export function hasDistinctValues(values: readonly string[]): boolean {
  return new Set(values).size === values.length
}

/**
 * Counts the UTF-8 bytes of a text.
 *
 * @param text - Any text; a lone surrogate counts as the three bytes of
 * U+FFFD, which replaces it in UTF-8.
 * @returns How many bytes its UTF-8 encoding has.
 */
export function calculateUtf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length
}
