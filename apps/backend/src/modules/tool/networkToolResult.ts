/**
 * Finds each character that shows nothing and is never needed to read
 * text: Unicode format characters (zero-width, direction controls, tag
 * characters) and control characters, except tab and line breaks. The
 * zero-width joiner and non-joiner are judged separately.
 */
const INVISIBLE_CHARACTER_PATTERN = /[[\p{Cf}\p{Cc}]--[\t\n\r\u200C\u200D]]/gv

/**
 * Finds each zero-width joiner or non-joiner that does not sit between two
 * visible characters: at an edge, next to whitespace, or next to another
 * joiner. Between two visible characters they shape emoji, Persian, and
 * Indic text.
 */
const STRAY_JOINER_PATTERN =
  /(?<=^|[\s\u200C\u200D])[\u200C\u200D]|[\u200C\u200D](?=$|[\s\u200C\u200D])/gu

/**
 * Formats the result of a tool that reaches the network for the model.
 *
 * @param content - Text the tool produced, which carries what a remote
 * server sent.
 * @returns The text without characters a person cannot see: format and
 * control characters other than tabs and line breaks, and zero-width
 * joiners and non-joiners that do not sit between two visible characters.
 * When any were removed, a last paragraph says how many, so the model can
 * tell the person the source tried to hide text; otherwise the text
 * unchanged.
 * @remarks Every content delimiter Lys writes around web text treats these
 * characters as part of a bracket run, so removing them never joins brackets
 * into a delimiter.
 */
export function formatNetworkToolResult(content: string): string {
  const visibleText = content
    .replace(INVISIBLE_CHARACTER_PATTERN, "")
    .replace(STRAY_JOINER_PATTERN, "")
  const removedCount =
    Array.from(content).length - Array.from(visibleText).length
  if (removedCount === 0) return content
  const unit = removedCount === 1 ? "character" : "characters"
  return `${visibleText}\n\nLys removed ${removedCount} invisible ${unit} from this result.`
}
