import { CITATION_MARKER_PATTERN } from "@lys/share"
import type {
  Blockquote,
  Heading,
  List,
  ListItem,
  Paragraph,
  Root,
  RootContent
} from "mdast"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"
import remarkParse from "remark-parse"
import { unified, type Data, type Processor } from "unified"

/**
 * Reference syntax found in a block's text, as {@link findReference} reads
 * it.
 */
type ReferenceSyntax = Readonly<{
  /**
   * Index of its first character: the {@link IMAGE_MARK} of an image, else
   * its `[`.
   */
  start: number
  /** Index just after its last `]`. */
  end: number
  /** Whether an {@link IMAGE_MARK} right before its `[` makes it an image. */
  isImage: boolean
  /** What its first, possibly nested, brackets enclose. */
  enclosed: string
  /** Whether a label in brackets, possibly empty, follows them. */
  hasLabel: boolean
}>

/**
 * An extension of the markdown parser's tree building, as remark plugins
 * register one.
 */
type TreeExtension = Exclude<
  NonNullable<Data["fromMarkdownExtensions"]>[number],
  readonly unknown[]
>

/** A handler the tree building runs when a token of its type ends. */
type TokenExitHandler = NonNullable<NonNullable<TreeExtension["exit"]>[string]>

/** The tree building's state, which a token handler runs on. */
type TreeBuildingContext = ThisParameterType<TokenExitHandler>

/** One token of the parsed markdown. */
type MarkdownToken = Parameters<TokenExitHandler>[0]

/** A block whose last child may be the block still being written. */
type BlockContainer = Root | Blockquote | List | ListItem

/**
 * Whether the last block of a text may still grow: `open` while its text
 * part is being written, `closed` once that part ended.
 */
type LastBlock = "open" | "closed"

/** Where a speech starts: the reply's first word, or the sentence being written. */
export type SpeechStart = "start" | "current"

/** Stored reply text a speech starts from. */
export type SpeechSnapshot = Readonly<{
  /** Markdown of the reply's text parts, in order, joined by blank lines. */
  text: string
  /**
   * `open` when the reply's last stored part is a text part still being
   * written, so its last sentence may grow; `closed` when that text part
   * ended, because another kind of part follows it or the reply is over.
   */
  lastTextPart: LastBlock
}>

/**
 * Parses reply markdown with the renderer's GFM and math syntax, marking
 * the brackets and `!` that escapes and character references write.
 */
const markdownParser = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(registerLiteralSyntaxMarking)

/** Shared segmenter for English sentences. */
const sentenceSegmenter = new Intl.Segmenter("en", { granularity: "sentence" })

/** Characters that terminate a spoken sentence, followed by optional closers. */
const SENTENCE_END_PATTERN = /[.!?…]["'”’)\]]*$/

/** Any letter, in any script. */
const LETTER_PATTERN = /\p{L}/u

/** One whole citation marker, such as `[1]`. */
const WHOLE_CITATION_MARKER = new RegExp(`^${CITATION_MARKER_PATTERN.source}$`)

/**
 * A mark in plain text that more text may parse again into something never
 * spoken: a `$` that a later `$` may pair into inline math, or the `![` of an
 * image whose syntax is not complete yet.
 */
const REPARSABLE_MARK = /\$|!\[/

/**
 * Where a paragraph still being written may yet become a link definition:
 * it starts with a label in brackets and a colon, and its title may still
 * be open.
 */
const DEFINITION_START = /^\[(?:[^[\]\\]|\\.)+\]:/

/** Opens inline code in a block's text, so its URLs read as written. */
const CODE_START = "\uE000"

/** Closes inline code in a block's text. */
const CODE_END = "\uE001"

/**
 * Stands for a `[` that is never reference syntax, one in inline code or
 * one an escape or a character reference writes, until the block is
 * formatted.
 */
const LITERAL_OPEN_BRACKET = "\uE002"

/**
 * Stands for a `]` that is never reference syntax, as
 * {@link LITERAL_OPEN_BRACKET} stands for a `[`.
 */
const LITERAL_CLOSE_BRACKET = "\uE003"

/**
 * Stands for a `!` right before a `[` written literally in the same text
 * node, the only `!` that may open image syntax: a `!` that ends another
 * node, or that an escape or a character reference writes, never does.
 */
const IMAGE_MARK = "\uE004"

/** Stands for a `!` that an escape or a character reference writes. */
const LITERAL_EXCLAMATION_MARK = "\uE005"

/**
 * Stands for the `[` of a shortcut link reference whose syntax was read, so
 * that it is told from a `[` that opens no reference.
 */
const SHORTCUT_OPEN_BRACKET = "\uE006"

/**
 * Stands for the `]` of a shortcut link reference whose syntax was read, as
 * {@link SHORTCUT_OPEN_BRACKET} stands for its `[`.
 */
const SHORTCUT_CLOSE_BRACKET = "\uE007"

/**
 * The private-use characters that mark a block's text; the reply's own are
 * removed before it is parsed.
 */
const TEXT_MARKS = new RegExp(
  `[${[
    CODE_START,
    CODE_END,
    LITERAL_OPEN_BRACKET,
    LITERAL_CLOSE_BRACKET,
    IMAGE_MARK,
    LITERAL_EXCLAMATION_MARK,
    SHORTCUT_OPEN_BRACKET,
    SHORTCUT_CLOSE_BRACKET
  ].join("")}]`,
  "g"
)

/**
 * A citation marker left in a block's text once its reference syntax was
 * read, with a bracket that an escape or a character reference wrote; its
 * other bracket, when written as syntax, opens or closes no reference. A
 * marker whose brackets are both syntax is a reference, which
 * {@link formatReference} drops.
 *
 * @remarks Built from the renderer's own {@link CITATION_MARKER_PATTERN} by
 * replacing the `\[` and `\]` that its source writes.
 */
const LITERAL_CITATION_MARKER = new RegExp(
  [
    CITATION_MARKER_PATTERN.source
      .replace("\\[", LITERAL_OPEN_BRACKET)
      .replace("\\]", `[\\]${LITERAL_CLOSE_BRACKET}]`),
    CITATION_MARKER_PATTERN.source.replace("\\]", LITERAL_CLOSE_BRACKET)
  ].join("|"),
  "g"
)

/**
 * One marked inline code span, captured so that splitting a block's text on
 * it keeps the span at every odd index.
 */
const CODE_SPAN = new RegExp(`(${CODE_START}[^${CODE_END}]*${CODE_END})`)

/**
 * A bare URL, which is not spoken: a scheme or `www.` and everything up to
 * the next whitespace, except the punctuation that ends it, such as the
 * period of its sentence.
 */
const BARE_URL = /\b(?:https?:\/\/|www\.)\S*[^\s.,:;!?"'’”)\]*_~]/giu

/**
 * Longest piece of text, in UTF-16 code units, sent to voice in one message.
 * voice refuses a message over 16 KiB; JSON writes one code unit as at most
 * six bytes, so a piece this long stays under that limit with the message's
 * other fields.
 */
const MAX_SPOKEN_PIECE_LENGTH = 2_000

/** A high surrogate, the first code unit of a pair. */
const HIGH_SURROGATE_PATTERN = /^[\uD800-\uDBFF]$/u

/**
 * Splits a sentence into pieces voice accepts in one message, at the last
 * space before each limit, or at the limit itself in a run without spaces.
 *
 * @param sentence - Sentence with its whitespace collapsed to single spaces.
 * @returns The sentence when it fits, or its pieces in order; never a piece
 * that splits a surrogate pair.
 */
export function buildVoiceTextPieces(sentence: string): string[] {
  const pieces: string[] = []
  let rest = sentence
  while (rest.length > MAX_SPOKEN_PIECE_LENGTH) {
    const cut = findPieceEnd(rest)
    pieces.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest !== "") pieces.push(rest)
  return pieces
}

/**
 * Finds where the first piece of an overlong text ends.
 *
 * @param text - Text longer than {@link MAX_SPOKEN_PIECE_LENGTH}.
 * @returns The index of the last space within the limit, or the limit
 * itself, moved back one when it would split a surrogate pair.
 */
function findPieceEnd(text: string): number {
  const space = text.lastIndexOf(" ", MAX_SPOKEN_PIECE_LENGTH)
  if (space > 0) return space
  const lastUnit = text.charAt(MAX_SPOKEN_PIECE_LENGTH - 1)
  return HIGH_SURROGATE_PATTERN.test(lastUnit)
    ? MAX_SPOKEN_PIECE_LENGTH - 1
    : MAX_SPOKEN_PIECE_LENGTH
}

/** Blocks that carry no words to speak. */
const SPOKEN_SILENCED: ReadonlySet<string> = new Set([
  "table",
  "code",
  "math",
  "html",
  "yaml",
  "definition",
  "footnoteDefinition",
  "thematicBreak"
])

/**
 * Buffers reply markdown and hands out the plain sentences voice speaks, as
 * they become final.
 *
 * @remarks The text is what the renderer shows, spoken: code blocks, math,
 * tables, images, bare URLs, and citation markers like `[1]`, found by the
 * renderer's own pattern, are not words, so they are not spoken; inline code is
 * read as words; formatting is dropped; a link is spoken by its text, and a
 * bare URL, in a link's text or not, is not spoken; each paragraph, heading,
 * and list item ends a sentence. A reference reads the same before its
 * definition arrives as after: a link by its text; a citation marker, an image,
 * and a footnote reference not at all; a bracket or a `!` an escape or a
 * character reference writes is never reference syntax, though a citation
 * marker it writes is still dropped, as the renderer still shows one, unless
 * its other bracket opens or closes a reference, as in `[see \[1]`, where it
 * reads as that reference's text, the same before the definition arrives as
 * after. Any other citation marker is dropped wherever it stands outside code,
 * a link's text included, where the renderer shows it as text. An unclosed code
 * fence holds the rest of the text back until it closes. A paragraph or heading
 * still being written waits until it ends when it holds a `|`, because its next
 * line may turn it into a table header, or when it starts with a label in
 * brackets and a colon, because a closing title quote may turn it into a link
 * definition; and from its first `$` or `![` outside code on, because a later
 * `$` may turn that text into inline math and the `![` may begin an image.
 *
 * A sentence is final once a later sentence holding a letter follows it, a
 * line break ends it, or its text part ends, so a period inside a number, a
 * version, or an abbreviation, such as `$3.50`, never ends a sentence
 * early; `close()` hands out the rest, however short. A sentence is handed
 * out at most once and never taken back. When more text changes how earlier
 * text reads, such as a line that turns into a table header, the buffer
 * resumes after the last handed-out sentence still present, so no later
 * sentence is skipped.
 *
 * Feed the buffer the reply's text: the snapshot at the start, then every
 * fragment as it arrives. `start` hands out every sentence; `current`
 * skips the sentences final when the snapshot loads and starts with the one
 * being written, or with the next text part when the snapshot's last text
 * part already ended. Concurrency model: single-owner.
 */
export class SpeechSentenceBuffer {
  /** The sentences handed out or skipped so far, in order. */
  readonly #handedOut: HandedSentence[] = []
  /** Markdown received so far, without the private-use marks it held. */
  #markdown = ""
  /** Whether the text's last block may still grow. */
  #lastBlock: LastBlock = "open"
  /** Where the speech starts. */
  readonly #start: SpeechStart

  /**
   * Creates a buffer with no text.
   *
   * @param start - `start` reads from the first word; `current` starts at
   * the sentence being written.
   */
  public constructor(start: SpeechStart) {
    this.#start = start
  }

  /**
   * Loads the stored reply text, before any fragment.
   *
   * @param snapshot - Stored text of the reply and whether its last text
   * part may still grow.
   * @returns The sentences ready to speak now: every final one for `start`,
   * none for `current`.
   */
  public loadSnapshot(snapshot: SpeechSnapshot): string[] {
    this.#markdown = snapshot.text.replace(TEXT_MARKS, "")
    this.#lastBlock = snapshot.lastTextPart
    if (this.#start === "start") return this.#addFinalSentences()
    const segments = buildSentenceSegments(
      formatUnheldSpeechText(this.#markdown, this.#lastBlock)
    )
    this.#addHandedOutSentences(segments, this.#calculateFinalCount(segments))
    return []
  }

  /**
   * Appends a streamed fragment of the text part being written.
   *
   * @param fragment - Fragment exactly as stored, or a new text part's
   * content after the blank line that separates it from the text before.
   * @returns The sentences the fragment made final, in order.
   */
  public addFragment(fragment: string): string[] {
    this.#markdown += fragment.replace(TEXT_MARKS, "")
    this.#lastBlock = "open"
    return this.#addFinalSentences()
  }

  /**
   * Ends the text part being written, because a part of another kind
   * follows it; the next fragment opens a new text part.
   *
   * @returns The sentences the part's end made final, in order.
   */
  public closeTextPart(): string[] {
    this.#lastBlock = "closed"
    return this.#addFinalSentences()
  }

  /**
   * Ends the text and hands out what is left, however short.
   *
   * @returns The rest of the text's sentences, in order; empty on a later
   * call.
   */
  public close(): string[] {
    this.#lastBlock = "closed"
    const segments = this.#buildSegments()
    return this.#addHandedOutSentences(segments, segments.length)
  }

  /**
   * Splits the current text into sentences.
   *
   * @returns The sentences of the plain text, in order.
   */
  #buildSegments(): SentenceSegment[] {
    return buildSentenceSegments(
      formatSpeechText(this.#markdown, this.#lastBlock)
    )
  }

  /**
   * Counts the leading sentences that can no longer change.
   *
   * @param segments - The sentences of the current text.
   * @returns How many leading sentences are final.
   */
  #calculateFinalCount(segments: readonly SentenceSegment[]): number {
    if (this.#lastBlock === "closed") return segments.length
    let count = 0
    for (const [index, segment] of segments.entries()) {
      const next = segments[index + 1]
      if (next === undefined) break
      if (!segment.endsLine && !LETTER_PATTERN.test(next.text)) break
      count = index + 1
    }
    return count
  }

  /**
   * Hands out every final sentence not handed out yet.
   *
   * @returns The newly final sentences, in order.
   */
  #addFinalSentences(): string[] {
    const segments = this.#buildSegments()
    return this.#addHandedOutSentences(
      segments,
      this.#calculateFinalCount(segments)
    )
  }

  /**
   * Hands out the sentences not handed out yet that come before `end`.
   *
   * @param segments - The sentences of the current text.
   * @param end - Index of the first sentence not to hand out.
   * @returns The sentences handed out, in order; empty ones are skipped.
   */
  #addHandedOutSentences(
    segments: readonly SentenceSegment[],
    end: number
  ): string[] {
    const start = this.#findResumeIndex(segments)
    const fresh: string[] = []
    for (const [offset, segment] of segments.slice(start, end).entries()) {
      if (segment.text === "") continue
      fresh.push(segment.text)
      this.#handedOut.push({
        index: start + offset,
        key: calculateSentenceKey(segment.text)
      })
    }
    return fresh
  }

  /**
   * Finds where the sentences not handed out yet start.
   *
   * @param segments - The sentences of the current text.
   * @returns The index after the last handed-out sentence still present,
   * looking for each at or before where it stood; `0` when none is.
   */
  #findResumeIndex(segments: readonly SentenceSegment[]): number {
    for (let rank = this.#handedOut.length - 1; rank >= 0; rank -= 1) {
      const handed = this.#handedOut.at(rank)
      if (handed === undefined) break
      const found = segments.findLastIndex(
        (segment, index) =>
          index <= handed.index &&
          calculateSentenceKey(segment.text) === handed.key
      )
      if (found !== -1) return found + 1
    }
    return 0
  }
}

/** One sentence handed out, by where it stood and what it says. */
type HandedSentence = Readonly<{
  /** Its index among the sentences of the text when it was handed out. */
  index: number
  /** Its letters and digits, which formatting closed later cannot change. */
  key: string
}>

/**
 * Reduces a sentence to what identifies it across readings of the text.
 *
 * @param text - A non-empty sentence.
 * @returns Its letters and digits in lower case, or the sentence itself
 * when it has none.
 */
function calculateSentenceKey(text: string): string {
  const key = text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")
  return key === "" ? text : key
}

/** One sentence of the plain text. */
type SentenceSegment = Readonly<{
  /** The sentence with its whitespace collapsed and trimmed; may be empty. */
  text: string
  /** Whether a line break ends it, which no later text can undo. */
  endsLine: boolean
}>

/**
 * Splits plain speech text into sentences.
 *
 * @param plain - Plain text, one block per line.
 * @returns The sentences, in order.
 */
function buildSentenceSegments(plain: string): SentenceSegment[] {
  return [...sentenceSegmenter.segment(plain)].map(({ segment }) => ({
    text: segment.replace(/\s+/g, " ").trim(),
    endsLine: hasTrailingLineBreak(segment)
  }))
}

/**
 * Whether a line break is among a segment's trailing whitespace; a line
 * break always ends a sentence.
 *
 * @param segment - One segment as the sentence segmenter returned it.
 * @returns Whether the segment ends a line.
 */
function hasTrailingLineBreak(segment: string): boolean {
  return segment.slice(segment.trimEnd().length).includes("\n")
}

/**
 * Converts reply markdown to the plain text voice speaks, one block per
 * line.
 *
 * @param markdown - The text to convert.
 * @param lastBlock - Whether the last block may still grow; every other
 * block, and a closed last one, ends with sentence punctuation.
 * @returns The plain text.
 */
function formatSpeechText(markdown: string, lastBlock: LastBlock): string {
  const tree = markdownParser.parse(markdown)
  if (lastBlock === "open") removeReparsableText(tree, markdown)
  return formatSpeechTree(tree, lastBlock)
}

/**
 * Converts reply markdown to plain text as it reads now, with nothing held
 * back for a reparse, so that a `current` join skips every sentence before
 * the one being written, also when that one waits in a held block.
 *
 * @param markdown - The text to convert.
 * @param lastBlock - Whether the last block may still grow.
 * @returns The plain text.
 */
function formatUnheldSpeechText(
  markdown: string,
  lastBlock: LastBlock
): string {
  return formatSpeechTree(markdownParser.parse(markdown), lastBlock)
}

/**
 * Renders a parsed reply as plain speech text, one block per line.
 *
 * @param tree - The parsed reply.
 * @param lastBlock - Whether the last block may still grow; every other
 * block, and a closed last one, ends with sentence punctuation.
 * @returns The plain text.
 */
function formatSpeechTree(tree: Root, lastBlock: LastBlock): string {
  const blocks: string[] = []
  for (const child of tree.children) addBlocks(child, blocks)
  return blocks
    .map((block, index) =>
      (index < blocks.length - 1 || lastBlock === "closed") &&
      !SENTENCE_END_PATTERN.test(block)
        ? `${block}.`
        : block
    )
    .join("\n")
}

/**
 * Leaves out the text of the paragraph or heading still being written that
 * more text may parse again into something never spoken: the whole block
 * when it holds a `|`, which the next line may turn into a table header, or
 * when it starts like a link definition, which a closing title quote may
 * complete, and the text from its first reparsable mark outside code on, as
 * {@link REPARSABLE_MARK} defines it. Those sentences wait until the block
 * ends. Handing them out earlier would let the reparse take them back, and
 * the sentence before them would then be spoken again.
 *
 * @param root - Parsed reply whose last block may still grow; changed in
 * place.
 * @param markdown - The reply's text, which `root` was parsed from.
 */
function removeReparsableText(root: Root, markdown: string): void {
  let container: BlockContainer = root
  for (;;) {
    const last: RootContent | undefined = container.children.at(-1)
    if (last === undefined) return
    if (last.type === "paragraph" || last.type === "heading") {
      removeReparsableLeaf(container, last, markdown)
      return
    }
    if (
      last.type !== "blockquote" &&
      last.type !== "list" &&
      last.type !== "listItem"
    )
      return
    container = last
  }
}

/**
 * Leaves out the text of the open paragraph or heading that more text may
 * parse again, as {@link removeReparsableText} describes.
 *
 * @param container - The block holding the leaf as its last child; changed
 * in place.
 * @param leaf - The paragraph or heading still being written; changed in
 * place.
 * @param markdown - The reply's text, which the leaf was parsed from.
 */
function removeReparsableLeaf(
  container: BlockContainer,
  leaf: Paragraph | Heading,
  markdown: string
): void {
  if (
    formatInlineChildren(leaf).includes("|") ||
    isPossibleDefinition(leaf, markdown)
  ) {
    container.children.pop()
    return
  }
  removeTextFromReparsableMark(leaf)
}

/**
 * Whether a paragraph still being written may yet become a link definition,
 * which is never spoken: while its title is open, it parses as text.
 *
 * @param leaf - The paragraph or heading still being written.
 * @param markdown - The reply's text, which the leaf was parsed from.
 * @returns Whether the leaf is a paragraph whose source starts with a label
 * in brackets and a colon.
 */
function isPossibleDefinition(
  leaf: Paragraph | Heading,
  markdown: string
): boolean {
  const start = leaf.position?.start.offset
  return (
    leaf.type === "paragraph" &&
    start !== undefined &&
    DEFINITION_START.test(markdown.slice(start))
  )
}

/**
 * Cuts a node's inline content at its first reparsable mark in plain text,
 * as {@link REPARSABLE_MARK} defines it: the text node holding the mark
 * keeps only its text before the mark, and every node after it is left
 * out. A mark in code or math is never parsed again, so it cuts nothing.
 *
 * @param node - The node to cut; changed in place.
 * @returns Whether the node held such a mark.
 * @remarks The tree is cut rather than rendered and rebuilt, so what
 * precedes the mark is rendered once, exactly as it would be without it.
 */
function removeTextFromReparsableMark(node: Root | RootContent): boolean {
  if (node.type === "text") {
    const index = node.value.search(REPARSABLE_MARK)
    if (index === -1) return false
    node.value = node.value.slice(0, index)
    return true
  }
  if (!("children" in node)) return false
  for (const [index, child] of node.children.entries()) {
    if (removeTextFromReparsableMark(child)) {
      node.children.length = index + 1
      return true
    }
  }
  return false
}

/**
 * Cleans one block of inline text: reference syntax outside inline code read
 * as {@link formatReferenceSyntax} reads it, bare URLs and the citation
 * markers left outside inline code dropped, every marked character turned
 * back into the one it stands for,
 * whitespace collapsed, and no space left before closing punctuation.
 * Inline code reads as written, so a citation-shaped index such as
 * `arr[1]`, or a URL, stays.
 *
 * @param text - Inline text of one block, marked as {@link formatInlineText}
 * and the parser mark it: its inline code, its literal brackets and `!`,
 * and its image marks.
 * @returns The cleaned text, possibly empty.
 */
function formatBlockText(text: string): string {
  return formatTextOutsideCode(formatReferenceSyntax(text))
    .replaceAll(IMAGE_MARK, "!")
    .replaceAll(LITERAL_EXCLAMATION_MARK, "!")
    .replaceAll(LITERAL_OPEN_BRACKET, "[")
    .replaceAll(LITERAL_CLOSE_BRACKET, "]")
    .replaceAll(SHORTCUT_OPEN_BRACKET, "[")
    .replaceAll(SHORTCUT_CLOSE_BRACKET, "]")
    .replace(TEXT_MARKS, "")
    .replace(/\s+/g, " ")
    .replace(/ ([.,;:!?)\]])/g, "$1")
    .trim()
}

/**
 * Drops the bare URLs and the {@link LITERAL_CITATION_MARKER} citation
 * markers of a block's text outside its inline code.
 *
 * @param text - A block's text once its reference syntax was read, marked as
 * {@link formatBlockText} receives it.
 * @returns The text without them.
 * @remarks Links render by their text, so a block's text keeps every
 * character the reply shows, and a URL reads the same whether GFM linked it,
 * which it does not inside a link's text, or not.
 */
function formatTextOutsideCode(text: string): string {
  return text
    .split(CODE_SPAN)
    .map((part, index) =>
      index % 2 === 0
        ? part.replace(LITERAL_CITATION_MARKER, "").replace(BARE_URL, "")
        : part
    )
    .join("")
}

/**
 * Renders the inline content of a node as speech text.
 *
 * @param node - Inline node, or a node whose children are inline.
 * @returns The words the node reads as; empty for content that is not
 * spoken. Inline code is marked, with its brackets stood in for, so that
 * {@link formatBlockText} reads reference syntax around it only, and a `!`
 * right before a `[` in a text node is marked as the only `!` that may open
 * an image.
 */
function formatInlineText(node: Root | RootContent): string {
  switch (node.type) {
    case "text":
      return node.value.replaceAll("![", `${IMAGE_MARK}[`)
    case "inlineCode":
      return formatInlineCode(node.value)
    case "linkReference": {
      const label = formatInlineChildren(node)
      return isCitationMarkerLabel(label) ? "" : label
    }
    case "image":
    case "imageReference":
    case "footnoteReference":
    case "inlineMath":
    case "html":
      return ""
    case "break":
      return " "
    default:
      return formatInlineChildren(node)
  }
}

/**
 * Marks inline code in a block's text, with its brackets stood in for, so
 * that reference syntax is never read inside it.
 *
 * @param code - The code as written.
 * @returns The marked code.
 */
function formatInlineCode(code: string): string {
  const stoodIn = code
    .replaceAll("[", LITERAL_OPEN_BRACKET)
    .replaceAll("]", LITERAL_CLOSE_BRACKET)
  return `${CODE_START}${stoodIn}${CODE_END}`
}

/**
 * Reads reference syntax in a block's text as a defined reference reads: a
 * full or collapsed link reference by its text, and a citation marker, an
 * image, or a footnote reference not at all. A shortcut link reference,
 * `[text]`, keeps its brackets, as {@link SHORTCUT_OPEN_BRACKET} and
 * {@link SHORTCUT_CLOSE_BRACKET}, which {@link formatBlockText} turns back;
 * brackets are not words, so it already reads as the link does.
 *
 * @param text - A block's text, or the text a reference's brackets enclose.
 * @returns The text with each reference read.
 * @remarks Until its definition arrives, a reference is text, which
 * formatting splits across nodes, as in `[*the* docs][d]`; reading the
 * block's joined text makes it read the same before its definition arrives
 * as after. Brackets nest, as link text may.
 */
function formatReferenceSyntax(text: string): string {
  let formatted = ""
  let index = 0
  for (;;) {
    const open = text.indexOf("[", index)
    if (open === -1) return formatted + text.slice(index)
    const reference = findReference(text, open)
    const end = reference === undefined ? open + 1 : reference.end
    formatted +=
      reference === undefined
        ? text.slice(index, end)
        : text.slice(index, reference.start) + formatReference(reference)
    index = end
  }
}

/**
 * Finds the reference syntax that starts at an opening bracket.
 *
 * @param text - A block's text, marked as {@link formatBlockText} receives
 * it, so a `[` or `]` is syntax and an {@link IMAGE_MARK} opens an image.
 * @param open - Index of a `[` in `text`.
 * @returns The syntax, or undefined when the bracket is never closed.
 */
function findReference(
  text: string,
  open: number
): ReferenceSyntax | undefined {
  const close = findClosingBracket(text, open)
  if (close === undefined) return undefined
  const labelEnd = text.startsWith("[", close + 1)
    ? text.indexOf("]", close + 2)
    : -1
  const hasLabel =
    labelEnd !== -1 && !text.slice(close + 2, labelEnd).includes("[")
  const isImage = text[open - 1] === IMAGE_MARK
  return {
    start: isImage ? open - 1 : open,
    end: hasLabel ? labelEnd + 1 : close + 1,
    isImage,
    enclosed: text.slice(open + 1, close),
    hasLabel
  }
}

/**
 * Finds the bracket that closes an opening one, counting nested pairs.
 *
 * @param text - Text to read.
 * @param open - Index of a `[` in `text`.
 * @returns The index of its `]`, or undefined when it is never closed.
 */
function findClosingBracket(text: string, open: number): number | undefined {
  let depth = 0
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "[") depth += 1
    if (text[index] === "]") depth -= 1
    if (depth === 0) return index
  }
  return undefined
}

/**
 * Reads one reference as it reads once defined.
 *
 * @param reference - The syntax {@link findReference} found.
 * @returns Its enclosed text, read the same way, in the brackets that
 * {@link SHORTCUT_OPEN_BRACKET} and {@link SHORTCUT_CLOSE_BRACKET} stand for
 * when it is a shortcut link reference; nothing for a citation marker, an
 * image, or a footnote reference.
 */
function formatReference(reference: ReferenceSyntax): string {
  if (
    reference.isImage ||
    reference.enclosed.startsWith("^") ||
    isCitationMarkerLabel(reference.enclosed)
  )
    return ""
  const enclosed = formatReferenceSyntax(reference.enclosed)
  return reference.hasLabel
    ? enclosed
    : `${SHORTCUT_OPEN_BRACKET}${enclosed}${SHORTCUT_CLOSE_BRACKET}`
}

/**
 * Whether a reference's text in brackets is a citation marker, which is
 * never spoken.
 *
 * @param label - What the reference's brackets enclose, such as `1`.
 * @returns Whether `[label]` is one whole citation marker.
 */
function isCitationMarkerLabel(label: string): boolean {
  return WHOLE_CITATION_MARKER.test(`[${label}]`)
}

/**
 * Renders the inline children of a node, concatenated.
 *
 * @param node - Node whose children to render.
 * @returns The children's words; empty for a node without children.
 */
function formatInlineChildren(node: Root | RootContent): string {
  if (!("children" in node)) return ""
  return node.children.map((child) => formatInlineText(child)).join("")
}

/**
 * Appends one block of speech text once cleaned, unless nothing is left.
 *
 * @param blocks - Blocks collected so far; receives the new one.
 * @param text - The block's inline text.
 */
function addBlockText(blocks: string[], text: string): void {
  const cleaned = formatBlockText(text)
  if (cleaned !== "") blocks.push(cleaned)
}

/**
 * Collects one list item: nested blocks become their own blocks, and the
 * item's inline runs join into one sentence.
 *
 * @param node - The list item.
 * @param blocks - Blocks collected so far; receives the item's.
 */
function addListItemBlocks(node: ListItem, blocks: string[]): void {
  const parts: string[] = []
  for (const child of node.children) {
    if (isBlockChild(child)) addBlocks(child, blocks)
    else parts.push(formatInlineText(child))
  }
  if (parts.length > 0) addBlockText(blocks, parts.join(" "))
}

/**
 * Collects the blocks of one subtree.
 *
 * @param node - Root of the subtree.
 * @param blocks - Blocks collected so far; receives the subtree's, in
 * order.
 */
function addBlocks(node: RootContent, blocks: string[]): void {
  switch (node.type) {
    case "paragraph":
    case "heading":
      addBlockText(blocks, formatInlineChildren(node))
      return
    case "listItem":
      addListItemBlocks(node, blocks)
      return
    default:
      break
  }
  if (SPOKEN_SILENCED.has(node.type) || !("children" in node)) return
  for (const child of node.children) addBlocks(child, blocks)
}

/**
 * Tells a list item's block children from its inline content.
 *
 * @param node - Child of a list item.
 * @returns Whether the child is a block rather than inline content.
 */
function isBlockChild(node: RootContent): boolean {
  return (
    node.type === "paragraph" ||
    node.type === "heading" ||
    node.type === "blockquote" ||
    node.type === "list" ||
    node.type === "code" ||
    node.type === "html" ||
    node.type === "table"
  )
}

/**
 * Registers the tree-building extension that marks the brackets and `!`
 * that an escape or a character reference writes in text, so that they are
 * never read as reference syntax, as the renderer never reads them.
 *
 * @param this - The processor being configured.
 */
function registerLiteralSyntaxMarking(this: Processor): void {
  const extension: TreeExtension = {
    exit: {
      characterEscapeValue: handleCharacterEscapeValueExit,
      characterReference: handleCharacterReferenceExit
    }
  }
  const data = this.data()
  data.fromMarkdownExtensions ??= []
  data.fromMarkdownExtensions.push(extension)
}

/**
 * Appends the character an escape writes to its text node, as the parser's
 * own handler does, marked when it is a bracket or a `!`.
 *
 * @param this - The tree building, with the text node on top of its stack.
 * @param token - The escaped character's token.
 * @throws {Error} If the node on top of the stack is not a text node, or has
 * no position, which the parser never allows.
 */
function handleCharacterEscapeValueExit(
  this: TreeBuildingContext,
  token: MarkdownToken
): void {
  const text = this.stack.pop()
  if (text?.type !== "text" || text.position === undefined)
    throw new Error(
      "A character escape ended outside a text node with a position"
    )
  text.value += formatLiteralSyntaxCharacter(this.sliceSerialize(token))
  text.position.end = {
    line: token.end.line,
    column: token.end.column,
    offset: token.end.offset
  }
}

/**
 * Ends a character reference's text, as the parser's own handler does,
 * marking the character it wrote when it is a bracket or a `!`.
 *
 * @param this - The tree building, with the text node on top of its stack.
 * @param token - The character reference's token.
 * @throws {Error} If the node on top of the stack is not a text node, or has
 * no position, which the parser never allows.
 * @remarks The reference's character was appended last; no reference to a
 * bracket or a `!` writes more than that one character.
 */
function handleCharacterReferenceExit(
  this: TreeBuildingContext,
  token: MarkdownToken
): void {
  const text = this.stack.pop()
  if (text?.type !== "text" || text.position === undefined)
    throw new Error(
      "A character reference ended outside a text node with a position"
    )
  const written = text.value.at(-1) ?? ""
  text.value =
    text.value.slice(0, text.value.length - written.length) +
    formatLiteralSyntaxCharacter(written)
  text.position.end = {
    line: token.end.line,
    column: token.end.column,
    offset: token.end.offset
  }
}

/**
 * Marks a character that is written literally, so that it is never read
 * as reference syntax.
 *
 * @param character - One character as written in the text.
 * @returns Its stand-in when it is a bracket or a `!`, else the character.
 */
function formatLiteralSyntaxCharacter(character: string): string {
  if (character === "[") return LITERAL_OPEN_BRACKET
  if (character === "]") return LITERAL_CLOSE_BRACKET
  if (character === "!") return LITERAL_EXCLAMATION_MARK
  return character
}
