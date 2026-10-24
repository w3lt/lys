/** Outcome of reading the arguments of a command written on one line. */
export type McpCommandArgumentsParse =
  | {
      /** Every quote is closed. */
      readonly status: "parsed"
      /** Arguments in order; empty when the line holds none. */
      readonly arguments: readonly string[]
    }
  | {
      /** A quote is not closed. */
      readonly status: "unclosed-quote"
      /** One-based position, in characters, of the quote that is not closed. */
      readonly position: number
    }

/** Quote that groups the characters of one argument. */
type ArgumentQuote = '"' | "'"

/** Reading of a line of arguments, one character at a time. */
type ArgumentScan = {
  /** Arguments already ended, in order. */
  readonly arguments: string[]
  /** Characters of the argument being read; empty between arguments. */
  current: string
  /** Whether an argument is being read, which may still be empty. */
  hasCurrent: boolean
  /** Quote the reading is inside of, or undefined outside quotes. */
  quote: ArgumentQuote | undefined
  /** One-based position of the quote the reading is inside of. */
  quotePosition: number
  /** Whether the previous character was a backslash inside double quotes. */
  isEscaping: boolean
}

/** Characters that end an argument outside quotes. */
const ARGUMENT_SEPARATORS: ReadonlySet<string> = new Set([" ", "\t"])

/** Characters a backslash makes literal inside double quotes. */
const ESCAPABLE_CHARACTERS: ReadonlySet<string> = new Set(['"', "\\"])

/**
 * Finds an argument that reads back unchanged without quotes: no white space,
 * quote, or backslash.
 */
const PLAIN_ARGUMENT_PATTERN = /^[^\s"'\\]+$/u

/**
 * Formats one argument so that {@link parseMcpCommandArguments} reads it back
 * unchanged.
 *
 * @param argument - Argument as saved.
 * @returns The argument as it is, or in double quotes, with every `"` and
 * `\` after a backslash, when it is empty or holds white space, a quote, or
 * a backslash.
 */
function formatMcpCommandArgument(argument: string): string {
  if (PLAIN_ARGUMENT_PATTERN.test(argument)) return argument
  const escapedArgument = argument.replaceAll(/["\\]/gu, String.raw`\$&`)
  return `"${escapedArgument}"`
}

/**
 * Formats a command's arguments on one line.
 *
 * @param commandArguments - Arguments in order.
 * @returns The arguments separated by single spaces, each quoted only when
 * it needs to be; {@link parseMcpCommandArguments} reads the line back as
 * the same arguments.
 */
export function formatMcpCommandArguments(
  commandArguments: readonly string[]
): string {
  return commandArguments.map(formatMcpCommandArgument).join(" ")
}

/**
 * Ends the argument being read, if any.
 *
 * @param scan - Reading in progress, updated in place.
 */
function endArgument(scan: ArgumentScan): void {
  if (scan.hasCurrent) scan.arguments.push(scan.current)
  scan.current = ""
  scan.hasCurrent = false
}

/**
 * Answers whether a character opens a quoted part of an argument.
 *
 * @param character - Character outside quotes.
 * @returns True for `"` and `'`.
 */
function isArgumentQuote(character: string): character is ArgumentQuote {
  return character === '"' || character === "'"
}

/**
 * Reads one character inside double quotes.
 *
 * @param scan - Reading in progress, updated in place.
 * @param character - Character to read.
 */
function readDoubleQuotedCharacter(
  scan: ArgumentScan,
  character: string
): void {
  if (scan.isEscaping) {
    const isEscapable = ESCAPABLE_CHARACTERS.has(character)
    scan.current += isEscapable ? character : `\\${character}`
    scan.isEscaping = false
  } else if (character === "\\") scan.isEscaping = true
  else if (character === '"') scan.quote = undefined
  else scan.current += character
}

/**
 * Reads one character inside single quotes, which keep every character as
 * it is.
 *
 * @param scan - Reading in progress, updated in place.
 * @param character - Character to read.
 */
function readSingleQuotedCharacter(
  scan: ArgumentScan,
  character: string
): void {
  if (character === "'") scan.quote = undefined
  else scan.current += character
}

/**
 * Reads one character outside quotes.
 *
 * @param scan - Reading in progress, updated in place.
 * @param character - Character to read.
 * @param position - One-based position of the character in the line.
 */
function readUnquotedCharacter(
  scan: ArgumentScan,
  character: string,
  position: number
): void {
  if (ARGUMENT_SEPARATORS.has(character)) {
    endArgument(scan)
    return
  }
  scan.hasCurrent = true
  if (isArgumentQuote(character)) {
    scan.quote = character
    scan.quotePosition = position
  } else scan.current += character
}

/**
 * Reads the arguments of a command written on one line.
 *
 * @param text - Line as typed.
 * @returns The arguments, or where the first quote that is not closed
 * starts. Spaces and tabs outside quotes separate arguments. Double quotes
 * group characters, in which a backslash makes the next `"` or `\` literal;
 * single quotes group characters as they are. Quotes may join other
 * characters of one argument, and `""` is an empty argument. A backslash
 * outside quotes is an ordinary character.
 */
export function parseMcpCommandArguments(
  text: string
): McpCommandArgumentsParse {
  const scan: ArgumentScan = {
    arguments: [],
    current: "",
    hasCurrent: false,
    quote: undefined,
    quotePosition: 0,
    isEscaping: false
  }
  for (const [index, character] of [...text].entries()) {
    if (scan.quote === '"') readDoubleQuotedCharacter(scan, character)
    else if (scan.quote === "'") readSingleQuotedCharacter(scan, character)
    else readUnquotedCharacter(scan, character, index + 1)
  }
  if (scan.quote !== undefined) {
    return Object.freeze({
      status: "unclosed-quote",
      position: scan.quotePosition
    })
  }
  endArgument(scan)
  return Object.freeze({
    status: "parsed",
    arguments: Object.freeze(scan.arguments)
  })
}
