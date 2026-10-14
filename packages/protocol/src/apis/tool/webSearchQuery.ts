/**
 * Finds a character a person cannot reliably see as written: a Unicode
 * default-ignorable code point, one of general category Other (a control,
 * format, surrogate, private-use, or unassigned code point), or a line or
 * paragraph separator.
 *
 * @remarks Default-ignorable code points include the zero-width, direction,
 * and tag characters, the variation selectors, and the Hangul fillers, which
 * show nothing yet carry text, or reorder the text around them. The 256
 * variation selectors can carry one byte each. The zero-width joiner of an
 * emoji sequence, the zero-width non-joiner of Persian and Indic scripts, and
 * the variation selectors of emoji and Mongolian text, such as the one that
 * draws `❤️` in color, are found too. Spaces other than U+0020, such as the
 * ideographic space of Chinese and Japanese text, and the blank braille
 * pattern are not found: the card shows each as a gap, though not which one.
 */
const HIDDEN_QUERY_CHARACTER_PATTERN =
  /[\p{C}\p{Default_Ignorable_Code_Point}\p{Zl}\p{Zp}]/u

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
