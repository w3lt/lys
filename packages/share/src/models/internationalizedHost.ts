/**
 * Script whose letters one part of an internationalized domain name may
 * hold. ASCII letters are Latin; Chinese, Japanese, and Korean letters form
 * one script, as names in those languages mix them.
 */
type HostScript = "latin" | "greek" | "cyrillic" | "cjk"

/**
 * Letters of one script that a part of an internationalized domain name may
 * hold: the code points from `first` to `last`, taking every `step`-th one.
 */
type ScriptLetterRange = {
  /** Script the letters belong to. */
  readonly script: HostScript
  /** First code point of the range. */
  readonly first: number
  /** Last code point of the range, inclusive. */
  readonly last: number
  /**
   * 1 to take every code point of the range, 2 to take every other one, for
   * a block where uppercase and lowercase letters alternate.
   */
  readonly step: 1 | 2
}

/**
 * Letters a part of an internationalized domain name may hold: ASCII
 * lowercase letters, and lowercase letters of long-stable left-to-right
 * scripts that are in Unicode's composed form and that UTS #46 keeps as
 * they are, so every URL parser Lys uses writes them alike.
 *
 * @remarks Leaves out right-to-left scripts, emoji, symbols, combining
 * marks, and newer characters; `ß`, final `ς`, `ĳ`, `ŀ`, `ŉ`, and `ſ`, which
 * UTS #46 maps or treats as deviations; and uppercase letters, which URL
 * parsers lowercase. The desktop host keeps the same list in its own copy
 * of this rule; changing one changes which settings files load and requires
 * a coordinated desktop and backend release.
 */
const ACCEPTED_LETTER_RANGES: readonly ScriptLetterRange[] = [
  // Basic Latin: a to z.
  { script: "latin", first: 0x61, last: 0x7a, step: 1 },
  // Latin-1 Supplement: à to ö, and ø to ÿ.
  { script: "latin", first: 0xe0, last: 0xf6, step: 1 },
  { script: "latin", first: 0xf8, last: 0xff, step: 1 },
  // Latin Extended-A: ā to ı, ĵ, ķ, ĸ to ľ, ł to ň, ŋ to ŷ, and ź to ž.
  { script: "latin", first: 0x101, last: 0x131, step: 2 },
  { script: "latin", first: 0x135, last: 0x137, step: 2 },
  { script: "latin", first: 0x138, last: 0x13e, step: 2 },
  { script: "latin", first: 0x142, last: 0x148, step: 2 },
  { script: "latin", first: 0x14b, last: 0x177, step: 2 },
  { script: "latin", first: 0x17a, last: 0x17e, step: 2 },
  // Greek: ά to ώ, without final ς.
  { script: "greek", first: 0x3ac, last: 0x3c1, step: 1 },
  { script: "greek", first: 0x3c3, last: 0x3ce, step: 1 },
  // Cyrillic: а to џ.
  { script: "cyrillic", first: 0x430, last: 0x45f, step: 1 },
  // Hiragana, Katakana with the prolonged sound mark, the CJK Unified
  // Ideographs of Unicode 1.1, and Hangul syllables.
  { script: "cjk", first: 0x3041, last: 0x3093, step: 1 },
  { script: "cjk", first: 0x30a1, last: 0x30f6, step: 1 },
  { script: "cjk", first: 0x30fc, last: 0x30fc, step: 1 },
  { script: "cjk", first: 0x4e00, last: 0x9fa5, step: 1 },
  { script: "cjk", first: 0xac00, last: 0xd7a3, step: 1 }
]

/** Start of a label of an internationalized domain name in ASCII form. */
const PUNYCODE_LABEL_PREFIX = "xn--"

/**
 * Most characters of the punycode after `xn--` in one label, inclusive: the
 * 63 characters of a DNS label less the prefix.
 */
const MAXIMUM_PUNYCODE_LENGTH = 59

/** Number of punycode digits, `base` in RFC 3492, section 5. */
const PUNYCODE_BASE = 36

/** Smallest digit threshold, `tmin` in RFC 3492, section 5. */
const PUNYCODE_MINIMUM_THRESHOLD = 1

/** Largest digit threshold, `tmax` in RFC 3492, section 5. */
const PUNYCODE_MAXIMUM_THRESHOLD = 26

/** Bias adaptation skew, `skew` in RFC 3492, section 5. */
const PUNYCODE_SKEW = 38

/** Divisor of the first delta's bias, `damp` in RFC 3492, section 5. */
const PUNYCODE_DAMP = 700

/** Bias of the first delta, `initial_bias` in RFC 3492, section 5. */
const PUNYCODE_INITIAL_BIAS = 72

/** First code point a delta can reach, `initial_n` in RFC 3492, section 5. */
const PUNYCODE_INITIAL_CODE_POINT = 0x80

/** Character after the basic code points of punycode, when it has any. */
const PUNYCODE_DELIMITER = "-"

/**
 * Punycode digits in value order: `a` to `z` are 0 to 25 and `0` to `9` are
 * 26 to 35. A decoder reads an uppercase letter as its lowercase one.
 */
const PUNYCODE_DIGITS = "abcdefghijklmnopqrstuvwxyz0123456789"

/**
 * Largest integer RFC 3492's decoder and encoder hold, inclusive: the
 * largest unsigned 32-bit integer. A larger one fails on overflow.
 */
const MAXIMUM_PUNYCODE_INTEGER = 0xffffffff

/** Largest Unicode code point. */
const MAXIMUM_CODE_POINT = 0x10ffff

/** First UTF-16 surrogate, which is not a character. */
const FIRST_SURROGATE = 0xd800

/** Last UTF-16 surrogate, which is not a character. */
const LAST_SURROGATE = 0xdfff

/** Finds a character beyond ASCII. */
const NON_ASCII_PATTERN = /\P{ASCII}/u

/** Finds every ASCII uppercase letter, for replacing. */
const ASCII_UPPERCASE_PATTERN = /[A-Z]/g

/** Finds a digit or a hyphen, which a part of any script may hold. */
const DIGIT_OR_HYPHEN_PATTERN = /^[0-9-]$/

/**
 * Finds the slashes and backslashes that the URL parser skips after the
 * scheme of an `http:` or `https:` URL.
 */
const AUTHORITY_START_PATTERN = /^[/\\]*/

/**
 * Finds a character that ends the authority of an `http:` or `https:` URL:
 * a slash, a backslash, `?`, or `#`.
 */
const AUTHORITY_END_PATTERN = /[/\\?#]/

/** RFC 3492 decoder state between two deltas of one punycode label. */
type PunycodeDecoding = {
  /** Code points decoded so far, in order. */
  readonly codePoints: readonly number[]
  /** Code point of the last insertion, `n` in RFC 3492. */
  readonly codePoint: number
  /** Position the next delta counts from, `i` in RFC 3492. */
  readonly position: number
  /** Bias of the next delta's digits. */
  readonly bias: number
}

/** One variable-length integer read from punycode. */
type PunycodeInteger = {
  /** Value of the integer, at most {@link MAXIMUM_PUNYCODE_INTEGER}. */
  readonly value: number
  /** Index of the character after the integer's last digit. */
  readonly end: number
}

/** RFC 3492 encoder state between two code points of one label. */
type PunycodeEncoding = {
  /** Punycode written so far. */
  readonly punycode: string
  /** Code point the next round starts from, `n` in RFC 3492. */
  readonly codePoint: number
  /** Delta carried into the next round. */
  readonly delta: number
  /** Bias of the next delta's digits. */
  readonly bias: number
  /** Code points of the text already encoded, `h` in RFC 3492. */
  readonly handledCount: number
}

/**
 * Calculates the threshold of one digit of a punycode integer (RFC 3492,
 * section 6.2).
 *
 * @param baseMultiple - The digit's `k`: the base times its one-based
 * position in the integer.
 * @param bias - Bias of the integer.
 * @returns The threshold, from {@link PUNYCODE_MINIMUM_THRESHOLD} to
 * {@link PUNYCODE_MAXIMUM_THRESHOLD}; a digit below it is the integer's
 * last.
 */
function calculatePunycodeThreshold(
  baseMultiple: number,
  bias: number
): number {
  if (baseMultiple <= bias) return PUNYCODE_MINIMUM_THRESHOLD
  if (baseMultiple >= bias + PUNYCODE_MAXIMUM_THRESHOLD)
    return PUNYCODE_MAXIMUM_THRESHOLD
  return baseMultiple - bias
}

/**
 * Calculates the bias of the next delta (RFC 3492, section 6.1).
 *
 * @param delta - Delta just decoded or encoded.
 * @param codePointCount - Code points of the label once the delta's code
 * point is in place.
 * @param isFirstDelta - Whether the delta is the label's first, which is
 * scaled down more.
 * @returns The bias of the next delta's digits.
 */
function calculatePunycodeBias(
  delta: number,
  codePointCount: number,
  isFirstDelta: boolean
): number {
  const digitRange = PUNYCODE_BASE - PUNYCODE_MINIMUM_THRESHOLD
  const firstScaledDelta = Math.floor(
    delta / (isFirstDelta ? PUNYCODE_DAMP : 2)
  )
  let scaledDelta =
    firstScaledDelta + Math.floor(firstScaledDelta / codePointCount)
  let baseMultiple = 0
  while (scaledDelta > (digitRange * PUNYCODE_MAXIMUM_THRESHOLD) / 2) {
    scaledDelta = Math.floor(scaledDelta / digitRange)
    baseMultiple += PUNYCODE_BASE
  }
  return (
    baseMultiple +
    Math.floor(((digitRange + 1) * scaledDelta) / (scaledDelta + PUNYCODE_SKEW))
  )
}

/**
 * Finds the value of one punycode digit.
 *
 * @param character - One ASCII character.
 * @returns 0 to 25 for a letter, either case, 26 to 35 for a digit, or
 * undefined for any other character.
 */
function findPunycodeDigitValue(character: string): number | undefined {
  const value = PUNYCODE_DIGITS.indexOf(character.toLowerCase())
  return character.length === 1 && value !== -1 ? value : undefined
}

/**
 * Parses one variable-length integer of punycode (RFC 3492, section 6.2).
 *
 * @param punycode - ASCII punycode the integer is in.
 * @param start - Index of the integer's first digit.
 * @param bias - Bias of the integer.
 * @returns The integer and where it ends, or undefined when a character is
 * not a digit, the punycode ends before the integer does, or the integer
 * overflows {@link MAXIMUM_PUNYCODE_INTEGER}.
 */
function parsePunycodeInteger(
  punycode: string,
  start: number,
  bias: number
): PunycodeInteger | undefined {
  let value = 0
  let weight = 1
  for (let index = start; index < punycode.length; index += 1) {
    const digit = findPunycodeDigitValue(punycode.charAt(index))
    if (digit === undefined) return undefined
    value += digit * weight
    if (value > MAXIMUM_PUNYCODE_INTEGER) return undefined
    const baseMultiple = PUNYCODE_BASE * (index - start + 1)
    const threshold = calculatePunycodeThreshold(baseMultiple, bias)
    if (digit < threshold) return { value, end: index + 1 }
    weight *= PUNYCODE_BASE - threshold
    if (weight > MAXIMUM_PUNYCODE_INTEGER) return undefined
  }
  return undefined
}

/**
 * Answers whether a number is a Unicode scalar value: a code point that is
 * not a surrogate.
 *
 * @param codePoint - Number to inspect, at least 0.
 * @returns True for a code point up to U+10FFFF outside the surrogates.
 */
function isScalarValue(codePoint: number): boolean {
  const isSurrogate =
    codePoint >= FIRST_SURROGATE && codePoint <= LAST_SURROGATE
  return codePoint <= MAXIMUM_CODE_POINT && !isSurrogate
}

/**
 * Calculates the decoder state after the code point of one decoded delta
 * is inserted (RFC 3492, section 6.2).
 *
 * @param decoding - Decoder state before the delta.
 * @param delta - Value of the delta's integer.
 * @returns The decoder state after the insertion, or undefined when the
 * position overflows {@link MAXIMUM_PUNYCODE_INTEGER} or the code point is
 * not a Unicode scalar value.
 */
function calculateNextPunycodeDecoding(
  decoding: PunycodeDecoding,
  delta: number
): PunycodeDecoding | undefined {
  const position = decoding.position + delta
  const codePointCount = decoding.codePoints.length + 1
  const codePoint = decoding.codePoint + Math.floor(position / codePointCount)
  if (position > MAXIMUM_PUNYCODE_INTEGER || !isScalarValue(codePoint))
    return undefined
  const insertionIndex = position % codePointCount
  const codePoints = [
    ...decoding.codePoints.slice(0, insertionIndex),
    codePoint,
    ...decoding.codePoints.slice(insertionIndex)
  ]
  return {
    codePoints,
    codePoint,
    position: insertionIndex + 1,
    bias: calculatePunycodeBias(delta, codePointCount, decoding.position === 0)
  }
}

/**
 * Parses punycode into the text it encodes, as RFC 3492's decoder does
 * (section 6.2), reading uppercase letters as lowercase ones.
 *
 * @param punycode - Punycode, such as the part of a label after `xn--`.
 * @returns The text, or undefined when the punycode is longer than
 * {@link MAXIMUM_PUNYCODE_LENGTH} characters, holds a character beyond
 * ASCII or a character that is not a digit where a digit belongs, ends
 * inside an integer, overflows, or encodes a code point that is not a
 * Unicode scalar value.
 */
function parsePunycode(punycode: string): string | undefined {
  if (punycode.length > MAXIMUM_PUNYCODE_LENGTH) return undefined
  if (NON_ASCII_PATTERN.test(punycode)) return undefined
  const delimiterIndex = punycode.lastIndexOf(PUNYCODE_DELIMITER)
  const basicCodePoints = Array.from(
    punycode.slice(0, Math.max(delimiterIndex, 0)),
    (character) => character.codePointAt(0) ?? 0
  )
  let decoding: PunycodeDecoding = {
    codePoints: basicCodePoints,
    codePoint: PUNYCODE_INITIAL_CODE_POINT,
    position: 0,
    bias: PUNYCODE_INITIAL_BIAS
  }
  let index = delimiterIndex > 0 ? delimiterIndex + 1 : 0
  while (index < punycode.length) {
    const delta = parsePunycodeInteger(punycode, index, decoding.bias)
    if (delta === undefined) return undefined
    const next = calculateNextPunycodeDecoding(decoding, delta.value)
    if (next === undefined) return undefined
    decoding = next
    index = delta.end
  }
  return String.fromCodePoint(...decoding.codePoints)
}

/**
 * Calculates the punycode digits of one integer (RFC 3492, section 6.3).
 *
 * @param value - Integer to write, at least 0.
 * @param bias - Bias of the integer.
 * @returns The integer's digits, in lowercase.
 */
function calculatePunycodeInteger(value: number, bias: number): string {
  let digits = ""
  let remainder = value
  for (let baseMultiple = PUNYCODE_BASE; ; baseMultiple += PUNYCODE_BASE) {
    const threshold = calculatePunycodeThreshold(baseMultiple, bias)
    if (remainder < threshold) return digits + PUNYCODE_DIGITS.charAt(remainder)
    const digitRange = PUNYCODE_BASE - threshold
    digits += PUNYCODE_DIGITS.charAt(
      threshold + ((remainder - threshold) % digitRange)
    )
    remainder = Math.floor((remainder - threshold) / digitRange)
  }
}

/**
 * Calculates one round of RFC 3492's encoder (section 6.3): writes the
 * deltas of every occurrence of the smallest code point not yet encoded.
 *
 * @param encoding - Encoder state before the round.
 * @param codePoints - Code points of the whole text, in order.
 * @param basicCount - How many of them are ASCII.
 * @returns The encoder state after the round, or undefined when a delta
 * overflows {@link MAXIMUM_PUNYCODE_INTEGER}.
 */
function calculateNextPunycodeEncoding(
  encoding: PunycodeEncoding,
  codePoints: readonly number[],
  basicCount: number
): PunycodeEncoding | undefined {
  const codePoint = Math.min(
    ...codePoints.filter((candidate) => candidate >= encoding.codePoint)
  )
  let { punycode, bias, handledCount } = encoding
  let delta =
    encoding.delta + (codePoint - encoding.codePoint) * (handledCount + 1)
  for (const candidate of codePoints) {
    if (candidate < codePoint) delta += 1
    if (candidate !== codePoint) continue
    if (delta > MAXIMUM_PUNYCODE_INTEGER) return undefined
    punycode += calculatePunycodeInteger(delta, bias)
    bias = calculatePunycodeBias(
      delta,
      handledCount + 1,
      handledCount === basicCount
    )
    delta = 0
    handledCount += 1
  }
  if (delta + 1 > MAXIMUM_PUNYCODE_INTEGER) return undefined
  return {
    punycode,
    codePoint: codePoint + 1,
    delta: delta + 1,
    bias,
    handledCount
  }
}

/**
 * Calculates the punycode of a text, as RFC 3492's encoder does (section
 * 6.3).
 *
 * @param text - Text to encode.
 * @returns The punycode, with its ASCII characters as they are and its
 * digits in lowercase, or undefined when a delta overflows
 * {@link MAXIMUM_PUNYCODE_INTEGER}.
 */
function calculatePunycode(text: string): string | undefined {
  const codePoints = [...text].map((character) => character.codePointAt(0) ?? 0)
  const basicText = [...text]
    .filter((character) => !NON_ASCII_PATTERN.test(character))
    .join("")
  let encoding: PunycodeEncoding | undefined = {
    punycode: basicText.length > 0 ? `${basicText}${PUNYCODE_DELIMITER}` : "",
    codePoint: PUNYCODE_INITIAL_CODE_POINT,
    delta: 0,
    bias: PUNYCODE_INITIAL_BIAS,
    handledCount: basicText.length
  }
  while (encoding !== undefined && encoding.handledCount < codePoints.length) {
    encoding = calculateNextPunycodeEncoding(
      encoding,
      codePoints,
      basicText.length
    )
  }
  return encoding?.punycode
}

/**
 * Answers whether a code point lies in one range of accepted letters.
 *
 * @param codePoint - Code point to inspect.
 * @param range - Range of one script's letters.
 * @returns True when the code point is one of the range's letters.
 */
function isInLetterRange(codePoint: number, range: ScriptLetterRange): boolean {
  const isWithinRange = codePoint >= range.first && codePoint <= range.last
  return isWithinRange && (codePoint - range.first) % range.step === 0
}

/**
 * Finds the script of an accepted letter.
 *
 * @param character - One character.
 * @returns The script of the letter, or undefined when the character is not
 * a letter a part of an internationalized domain name may hold.
 */
function findLetterScript(character: string): HostScript | undefined {
  const codePoint = character.codePointAt(0) ?? 0
  return ACCEPTED_LETTER_RANGES.find((range) =>
    isInLetterRange(codePoint, range)
  )?.script
}

/**
 * Answers whether the hyphens of a part of a domain name stand where DNS
 * names allow them: not at either end, and not as its third and fourth
 * characters, which mark a label such as `xn--`.
 *
 * @param characters - Characters of the part, in order.
 * @returns True when no hyphen stands at those places.
 */
function hasAcceptedHyphens(characters: readonly string[]): boolean {
  const hasEdgeHyphen = characters[0] === "-" || characters.at(-1) === "-"
  const hasHyphenPair = characters[2] === "-" && characters[3] === "-"
  return !hasEdgeHyphen && !hasHyphenPair
}

/**
 * Answers whether the text of one part of an internationalized domain name
 * follows the rule: accepted letters of one script, digits, and hyphens,
 * with hyphens only where {@link hasAcceptedHyphens} allows them.
 *
 * @param text - Text of the part as a person types it.
 * @returns True when the part is not empty and follows the rule.
 */
function isAcceptedLabelText(text: string): boolean {
  const characters = [...text]
  if (characters.length === 0 || !hasAcceptedHyphens(characters)) return false
  const scripts = characters
    .filter((character) => !DIGIT_OR_HYPHEN_PATTERN.test(character))
    .map((character) => findLetterScript(character))
  return scripts.every(
    (script) => script !== undefined && script === scripts[0]
  )
}

/**
 * Parses one label of a host, as the URL parser wrote it, into the text a
 * person types for it.
 *
 * @param label - Label in lowercase ASCII.
 * @returns The text of a label starting with `xn--`, decoded from its
 * punycode, or any other label as it is; undefined when the punycode does
 * not decode, decodes to ASCII only, or is not exactly what the text
 * encodes to.
 * @remarks The decoder's refusals do refuse hosts: some URL parsers write a
 * label starting with `xn--` as it was typed even when its punycode does not
 * decode. The last check is a guard: no punycode is known that decodes but
 * is not exactly what its text encodes to.
 */
function parseLabelText(label: string): string | undefined {
  if (!label.startsWith(PUNYCODE_LABEL_PREFIX)) return label
  const punycode = label.slice(PUNYCODE_LABEL_PREFIX.length)
  const text = parsePunycode(punycode)
  if (text === undefined || !NON_ASCII_PATTERN.test(text)) return undefined
  return calculatePunycode(text) === punycode ? text : undefined
}

/**
 * Answers whether one label of an internationalized domain name follows the
 * rule and is what the URL text holds.
 *
 * @param typedLabel - The label as the URL text holds it.
 * @param label - The same label as the URL parser wrote it.
 * @returns True when the label's text follows {@link isAcceptedLabelText},
 * and the typed label, with its ASCII letters in lowercase, is that text or
 * the label's punycode form; false when the parser changed any other
 * character.
 */
function isAcceptedLabel(typedLabel: string, label: string): boolean {
  const typedText = typedLabel.replace(ASCII_UPPERCASE_PATTERN, (letter) =>
    letter.toLowerCase()
  )
  const text = parseLabelText(label)
  if (text === undefined || !isAcceptedLabelText(text)) return false
  return typedText === text || typedText === label
}

/**
 * Gets the host of an `http:` or `https:` URL as its text holds it, before
 * the URL parser converts it: after the scheme, the slashes or backslashes
 * that follow it, and any user name and password, up to the port, path,
 * query, or fragment.
 *
 * @param urlText - Text of a URL that parses with an `http:` or `https:`
 * scheme.
 * @returns The host as typed, with the brackets of an IPv6 address.
 */
function getTypedHost(urlText: string): string {
  const afterScheme = urlText
    .slice(urlText.indexOf(":") + 1)
    .replace(AUTHORITY_START_PATTERN, "")
  const authority = afterScheme.split(AUTHORITY_END_PATTERN, 1)[0] ?? ""
  const hostAndPort = authority.slice(authority.lastIndexOf("@") + 1)
  if (hostAndPort.startsWith("["))
    return hostAndPort.slice(0, hostAndPort.indexOf("]") + 1)
  return hostAndPort.split(":", 1)[0] ?? ""
}

/**
 * Answers whether a host is plain ASCII: typed without a character beyond
 * ASCII, and written by the URL parser without a label starting with
 * `xn--`, which a percent-encoded name can also get.
 *
 * @param typedHost - The host as the URL text holds it.
 * @param hostname - The host as the URL parser wrote it.
 * @returns True for a plain ASCII host.
 */
function isPlainAsciiHost(typedHost: string, hostname: string): boolean {
  const hasPunycodeLabel = hostname
    .split(".")
    .some((label) => label.startsWith(PUNYCODE_LABEL_PREFIX))
  return !NON_ASCII_PATTERN.test(typedHost) && !hasPunycodeLabel
}

/**
 * Answers whether an internationalized domain name follows the rule: typed
 * without percent-encoding, with the same parts the URL parser wrote, each
 * following {@link isAcceptedLabel}.
 *
 * @param typedHost - The host as the URL text holds it.
 * @param hostname - The host as the URL parser wrote it.
 * @returns True when every part follows the rule; false when the text
 * percent-encodes the host or separates its parts with a character the URL
 * parser turns into a dot, such as `。`.
 */
function isAcceptedInternationalizedHost(
  typedHost: string,
  hostname: string
): boolean {
  const typedLabels = typedHost.split(".")
  const labels = hostname.split(".")
  if (typedHost.includes("%") || typedLabels.length !== labels.length)
    return false
  return labels.every((label, index) =>
    isAcceptedLabel(typedLabels[index] ?? "", label)
  )
}

/**
 * Answers whether the host of an `http:` or `https:` URL is one Lys
 * accepts: plain ASCII, or an internationalized domain name whose every
 * part is lowercase letters of one of the Latin, Greek, Cyrillic, Chinese,
 * Japanese, or Korean scripts, digits, and hyphens, typed as those letters
 * or as their punycode.
 *
 * @param urlText - Text of a URL that parses with an `http:` or `https:`
 * scheme.
 * @param hostname - The URL's host as the URL parser wrote it.
 * @returns True for a plain ASCII host, which the other URL rules judge,
 * and for an internationalized domain name that follows the rule; false for
 * every other host.
 * @remarks URL parsers do not convert internationalized domain names alike:
 * the desktop host's, Node's, and WebKit's accept different ones and map
 * some characters to others. A name passes only when the parser kept every
 * typed character, apart from ASCII case, so every parser that accepts it
 * writes the same host. The desktop host checks the same rule, in its own
 * copy, when it loads the settings file.
 */
export function isAcceptedHost(urlText: string, hostname: string): boolean {
  const typedHost = getTypedHost(urlText)
  if (isPlainAsciiHost(typedHost, hostname)) return true
  return isAcceptedInternationalizedHost(typedHost, hostname)
}
