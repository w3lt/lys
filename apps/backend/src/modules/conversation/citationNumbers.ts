import { CITATION_MARKER_PATTERN } from "@lys/share"

/** A text whose citation markers carry new numbers, and the numbers it got. */
export type RenumberedCitations = Readonly<{
  /**
   * The text with each renumbered marker carrying its new number; every
   * other character is as it was.
   */
  text: string
  /**
   * The new number of each renumbered marker, ascending and each once; empty
   * when no marker was renumbered.
   */
  citedNumbers: readonly number[]
}>

/**
 * Lists numbers smallest first.
 *
 * @param numbers - Numbers, each once.
 * @returns A new list of the numbers in ascending order.
 */
function listAscendingNumbers(numbers: ReadonlySet<number>): readonly number[] {
  return [...numbers].toSorted((left, right) => left - right)
}

/**
 * Lists the numbers a text cites.
 *
 * @param text - Text whose citation markers carry source numbers; a marker
 * in code counts too.
 * @returns The number of each `[n]` marker, ascending and each once; none
 * when the text has no marker.
 */
export function listCitedNumbers(text: string): readonly number[] {
  const citedNumbers = new Set<number>()
  for (const marker of text.matchAll(CITATION_MARKER_PATTERN))
    citedNumbers.add(Number(marker[1]))
  return listAscendingNumbers(citedNumbers)
}

/**
 * Builds a text whose citation markers carry new numbers.
 *
 * @param text - Text whose `[n]` markers carry the old numbers; a marker in
 * code counts too.
 * @param numbers - New number for each old number; a marker whose number is
 * no key keeps its number.
 * @returns The text with each marker whose number is a key rewritten, in one
 * pass, so a marker written with a new number is never rewritten again; and
 * the new numbers it wrote, ascending and each once.
 */
export function buildRenumberedCitations(
  text: string,
  numbers: ReadonlyMap<number, number>
): RenumberedCitations {
  const citedNumbers = new Set<number>()
  let renumberedText = ""
  let copiedLength = 0
  for (const marker of text.matchAll(CITATION_MARKER_PATTERN)) {
    const newNumber = numbers.get(Number(marker[1]))
    if (newNumber === undefined) continue
    renumberedText += `${text.slice(copiedLength, marker.index)}[${newNumber}]`
    copiedLength = marker.index + marker[0].length
    citedNumbers.add(newNumber)
  }
  return {
    text: renumberedText + text.slice(copiedLength),
    citedNumbers: listAscendingNumbers(citedNumbers)
  }
}
