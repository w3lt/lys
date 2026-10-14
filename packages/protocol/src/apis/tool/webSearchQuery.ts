/**
 * Finds a character a person cannot reliably see as written: one of Unicode
 * general category Other (a control, format, surrogate, private-use, or
 * unassigned code point), or a line or paragraph separator.
 *
 * @remarks Format characters include the zero-width, direction, and tag
 * characters, which show nothing yet carry text, or reorder the text around
 * them. The zero-width joiner of an emoji sequence and the zero-width
 * non-joiner of Persian and Indic scripts are format characters too.
 */
const HIDDEN_QUERY_CHARACTER_PATTERN = /[\p{C}\p{Zl}\p{Zp}]/u

/**
 * Answers whether a web search query holds a character a person cannot
 * reliably see, so that the approval card could show a query that differs
 * from the one sent to Tavily.
 *
 * @param query - Query as the model wrote it.
 * @returns True when the query holds at least one such character.
 * @remarks The backend refuses such a query before anyone is asked to allow
 * it, and the desktop refuses to describe one, so the card always shows the
 * whole query sent. Whether a code point is unassigned depends on the running
 * engine's Unicode version: a character assigned in a newer version is
 * refused by an engine that does not know it yet, and the search then does
 * not run.
 */
export function hasHiddenWebSearchQueryCharacter(query: string): boolean {
  return HIDDEN_QUERY_CHARACTER_PATTERN.test(query)
}
