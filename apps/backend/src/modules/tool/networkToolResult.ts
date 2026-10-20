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
 * Finds each variation selector except one text-style (U+FE0E) or
 * emoji-style (U+FE0F) selector right after a visible character, which is
 * how emoji and keycaps are written. Any other selector only picks a rare
 * alternate shape, and a run of them can spell a message a person never
 * sees, one byte per selector.
 */
const STRAY_VARIATION_SELECTOR_PATTERN =
  /[\p{Variation_Selector}--[\uFE0E\uFE0F]]|(?<=^|[\s\p{Variation_Selector}\u200C\u200D])[\uFE0E\uFE0F]/gv

/**
 * Formats untrusted text without the characters a person cannot see.
 *
 * @param text - Text that carries what a remote server sent.
 * @returns The text without the characters {@link formatNetworkToolResult}
 * removes, otherwise unchanged: whitespace that sat beside them is kept, so
 * the text can be blank without being empty.
 */
export function formatVisibleText(text: string): string {
  return text
    .replace(INVISIBLE_CHARACTER_PATTERN, "")
    .replace(STRAY_JOINER_PATTERN, "")
    .replace(STRAY_VARIATION_SELECTOR_PATTERN, "")
}

/**
 * Formats the result of a tool that reaches the network for the model.
 *
 * @param content - Text the tool produced, which carries what a remote
 * server sent.
 * @returns The text without characters a person cannot see: format and
 * control characters other than tabs and line breaks, zero-width joiners
 * and non-joiners that do not sit between two visible characters, and
 * every variation selector except one text- or emoji-style selector right
 * after a visible character. When any were removed, a last paragraph says
 * how many, so the model can tell the person the source tried to hide text;
 * otherwise the text unchanged.
 * @remarks Every content delimiter Lys writes around web text treats these
 * characters as part of a bracket run, so removing them never joins brackets
 * into a delimiter.
 */
export function formatNetworkToolResult(content: string): string {
  const visibleText = formatVisibleText(content)
  const removedCount =
    Array.from(content).length - Array.from(visibleText).length
  if (removedCount === 0) return content
  const unit = removedCount === 1 ? "character" : "characters"
  return `${visibleText}\n\nLys removed ${removedCount} invisible ${unit} from this result.`
}
