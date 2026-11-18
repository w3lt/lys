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
import { unified } from "unified"

/** A span of the reply's source text, by UTF-16 offset. */
type SourceRange = Readonly<{ start: number; end: number }>

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

/** Parses reply markdown with the renderer's GFM and math syntax. */
const markdownParser = unified().use(remarkParse).use(remarkGfm).use(remarkMath)

/** Shared segmenter for English sentences. */
const sentenceSegmenter = new Intl.Segmenter("en", { granularity: "sentence" })

/** Characters that terminate a spoken sentence, followed by optional closers. */
/**
 * The citation markers the renderer links, such as `[1]`; a copy of the
 * shared pattern, because that one is frozen.
 */
const CITATION_MARKERS = new RegExp(CITATION_MARKER_PATTERN.source, "g")

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
 * Reference syntax as text shows it, which is how every reference parses
 * once the reply's definitions are left out: `[text][label]`, `[text][]`, `[text]`, `![alt][label]`, `![alt]`, and
 * `[^label]`. Group 1 is the image mark, group 2 what the first brackets
 * enclose, and group 3 the label's brackets, when there are any.
 */
const REFERENCE_SYNTAX = /(!?)\[([^[\]]*)\](\[[^[\]]*\])?/g

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
 * @remarks The text is what the renderer shows, spoken: citation markers
 * like `[1]`, code blocks, math, tables, images, and bare URLs are not
 * words, so they are not spoken; inline code is read as words; formatting
 * is dropped; a link is spoken by its text, unless the text is the URL
 * itself; each paragraph, heading, and list item ends a sentence. The
 * text is read as if it held no link or footnote definition, so a reference
 * reads the same before its definition arrives as after: a link by its
 * text; a citation marker, an image, and a footnote reference not at all.
 * An unclosed code fence holds the rest of the text back until it
 * closes. A paragraph or heading still being written waits until it ends
 * when it holds a `|`, because its next line may turn it into a table
 * header, and from its first `$` or `![` outside code on, because a later
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
  /** Raw markdown received so far. */
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
    this.#markdown = snapshot.text
    this.#lastBlock = snapshot.lastTextPart
    if (this.#start === "start") return this.#addFinalSentences()
    const segments = this.#buildSegments()
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
    this.#markdown += fragment
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
    const plain = formatSpeechText(this.#markdown, this.#lastBlock)
    return [...sentenceSegmenter.segment(plain)].map(({ segment }) => ({
      text: segment.replace(/\s+/g, " ").trim(),
      endsLine: hasTrailingLineBreak(segment)
    }))
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
  const tree = parseWithoutDefinitions(markdown)
  if (lastBlock === "open") removeReparsableText(tree)
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
 * when it holds a `|`, which the next line may turn into a table header,
 * and the text from its first reparsable mark outside code on, as
 * {@link REPARSABLE_MARK} defines it. Those sentences wait until the block
 * ends.
 * Handing them out earlier would let the reparse take them back, and the
 * sentence before them would then be spoken again.
 *
 * @param root - Parsed reply whose last block may still grow; changed in
 * place.
 */
function removeReparsableText(root: Root): void {
  let container: BlockContainer = root
  for (;;) {
    const last: RootContent | undefined = container.children.at(-1)
    if (last === undefined) return
    if (last.type === "paragraph" || last.type === "heading") {
      removeReparsableLeaf(container, last)
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
 */
function removeReparsableLeaf(
  container: BlockContainer,
  leaf: Paragraph | Heading
): void {
  if (formatInlineChildren(leaf).includes("|")) {
    container.children.pop()
    return
  }
  removeTextFromReparsableMark(leaf)
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
 * Cleans one block of inline text: citation markers dropped, whitespace
 * collapsed, and no space left before closing punctuation.
 *
 * @param text - Inline text of one block.
 * @returns The cleaned text, possibly empty.
 */
function formatBlockText(text: string): string {
  return text
    .replace(CITATION_MARKERS, "")
    .replace(/\s+/g, " ")
    .replace(/ ([.,;:!?)\]])/g, "$1")
    .trim()
}

/**
 * Parses reply markdown as if it held no link or footnote definition.
 *
 * @param markdown - The reply's text.
 * @returns The parsed reply, in which every reference is plain text.
 * @remarks A definition may follow its reference by any number of
 * paragraphs, and it changes how the reference parses. Parsing as if no
 * definition existed makes a reference read the same before its definition
 * arrives as after, so a sentence already spoken never reads differently
 * later. Definitions are never spoken, so blanking them loses no words.
 */
function parseWithoutDefinitions(markdown: string): Root {
  const tree = markdownParser.parse(markdown)
  const ranges = listDefinitionRanges(tree)
  if (ranges.length === 0) return tree
  let blanked = ""
  let end = 0
  for (const range of ranges) {
    blanked += markdown.slice(end, range.start)
    blanked += markdown.slice(range.start, range.end).replace(/[^\n]/g, " ")
    end = range.end
  }
  return markdownParser.parse(blanked + markdown.slice(end))
}

/**
 * Lists where the link and footnote definitions of a subtree are written.
 *
 * @param node - Root of the subtree.
 * @returns The definitions' source ranges, in document order. The parser
 * records a position on every node, so none is skipped in practice; a
 * definition without one would be kept, and its references would read
 * as defined.
 */
function listDefinitionRanges(node: Root | RootContent): SourceRange[] {
  if (node.type === "definition" || node.type === "footnoteDefinition") {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    return start === undefined || end === undefined ? [] : [{ start, end }]
  }
  if (!("children" in node)) return []
  return node.children.flatMap(listDefinitionRanges)
}

/**
 * Renders the inline content of a node as speech text.
 *
 * @param node - Inline node, or a node whose children are inline.
 * @returns The words the node reads as; empty for content that is not
 * spoken.
 */
function formatInlineText(node: Root | RootContent): string {
  switch (node.type) {
    case "text":
      return formatReferenceSyntax(node.value)
    case "inlineCode":
      return node.value
    case "link":
      return formatLinkText(formatInlineChildren(node), node.url)
    case "image":
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
 * Reads reference syntax in plain text as a defined reference reads: a full
 * or collapsed link reference by its text, and a citation marker, an image,
 * or a footnote reference not at all. A shortcut link reference, `[text]`,
 * is left as it is: its brackets are not words, so it already reads as the
 * link does. Syntax that formatting splits across nodes, such as
 * `[*the* docs][d]`, stays as written; it reads the same whether its
 * definition arrived or not, because the reply is parsed without its
 * definitions.
 *
 * @param text - A text node's value.
 * @returns The text with each reference replaced.
 */
function formatReferenceSyntax(text: string): string {
  let formatted = ""
  let end = 0
  for (const reference of text.matchAll(REFERENCE_SYNTAX)) {
    formatted += text.slice(end, reference.index) + formatReference(reference)
    end = reference.index + reference[0].length
  }
  return formatted + text.slice(end)
}

/**
 * Reads one match of {@link REFERENCE_SYNTAX} as its reference reads once
 * defined.
 *
 * @param reference - The match, with its image mark, enclosed text, and
 * label brackets.
 * @returns The enclosed text, nothing, or the syntax unchanged for a
 * shortcut link reference.
 */
function formatReference(reference: RegExpExecArray): string {
  const [syntax, imageMark, enclosed = "", labelBrackets] = reference
  if (
    imageMark === "!" ||
    enclosed.startsWith("^") ||
    isCitationMarkerLabel(enclosed)
  )
    return ""
  return labelBrackets === undefined ? syntax : enclosed
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
 * Renders a link by its text.
 *
 * @param label - The link's text, already rendered.
 * @param url - Where the link points.
 * @returns The label, or nothing when the label is the URL itself.
 */
function formatLinkText(label: string, url: string): string {
  const formatForComparison = (value: string) =>
    value
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/$/, "")
  return formatForComparison(label) === formatForComparison(url) ? "" : label
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
