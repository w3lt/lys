/**
 * Lists the texts a one-line input holds after each keystroke while the
 * person changes its text: Backspace from the end down to the start both
 * texts share, then one typed character at a time.
 *
 * @param fromText - Text the input holds before the first keystroke.
 * @param toText - Text it holds after the last keystroke.
 * @returns A frozen list with one text per keystroke, in order, counting
 * characters as Unicode code points; the last is `toText`, and the list is
 * empty when both texts are equal.
 */
export function listKeystrokeTexts(
  fromText: string,
  toText: string
): readonly string[] {
  const fromCharacters = [...fromText]
  const toCharacters = [...toText]
  let sharedCount = 0
  while (
    sharedCount < fromCharacters.length &&
    fromCharacters[sharedCount] === toCharacters[sharedCount]
  ) {
    sharedCount += 1
  }
  const deletions = fromCharacters
    .slice(sharedCount)
    .map((_, index) => fromCharacters.slice(0, -1 - index).join(""))
  const additions = toCharacters
    .slice(sharedCount)
    .map((_, index) => toCharacters.slice(0, sharedCount + 1 + index).join(""))
  return Object.freeze([...deletions, ...additions])
}
