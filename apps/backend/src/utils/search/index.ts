/**
 * Builds the pattern that finds a search query in text.
 * @param query - Search text, taken literally.
 * @returns A Unicode, case-insensitive pattern that matches the query as a
 * literal substring, using JavaScript's simple case folding, which does not
 * depend on the locale.
 */
function buildSearchPattern(query: string): RegExp {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`), "iu")
}

/**
 * Tells whether text contains a search query, ignoring case.
 * @param content - Text searched.
 * @param query - Search text, taken literally; regular-expression and SQL
 * wildcard characters match only themselves.
 * @returns True when the query is a substring of the text under Unicode
 * simple case folding; true for an empty query.
 */
export function hasSearchText(content: string, query: string): boolean {
  return buildSearchPattern(query).test(content)
}

/**
 * Tells whether text equals a search query, ignoring case.
 * @param content - Text compared.
 * @param query - Search text, taken literally.
 * @returns True when the text contains the query under Unicode simple case
 * folding and both have the same number of code points. Simple case folding
 * maps each code point to one code point, so that means the whole text
 * matches.
 */
export function isExactSearchMatch(content: string, query: string): boolean {
  return (
    [...content].length === [...query].length && hasSearchText(content, query)
  )
}
