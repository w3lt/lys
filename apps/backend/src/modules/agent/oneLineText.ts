/**
 * Formats text a person or a model wrote onto one line.
 *
 * @param text - Name, description, or title.
 * @returns The text with each whitespace run, line breaks included, as one
 * space.
 */
export function formatOneLine(text: string): string {
  /** Matches one run of whitespace, line breaks included. */
  const whitespaceRunPattern = /\s+/g

  return text.replaceAll(whitespaceRunPattern, " ")
}
