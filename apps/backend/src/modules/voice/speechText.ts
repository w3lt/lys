import { CITATION_MARKER_PATTERN } from "@lys/share"
import type { ListItem, Root, RootContent } from "mdast"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"
import remarkParse from "remark-parse"
import { unified } from "unified"

/** Definitions of link references, keyed by their lower-cased label. */
type Definitions = Map<string, string>

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
const SENTENCE_END_PATTERN = /[.!?…]["'”’)\]]*$/

/** Any letter, in any script. */
const LETTER_PATTERN = /\p{L}/u

/** A line break, which always ends a sentence. */
const LINE_BREAK_PATTERN = /\n\s*$/

/**
 * The citation markers the renderer links, such as `[1]`; a copy of the
 * shared pattern, because that one is frozen.
 */
const CITATION_MARKERS = new RegExp(CITATION_MARKER_PATTERN.source, "g")

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
export function splitForVoice(sentence: string): string[] {
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
 * itself; each paragraph, heading, and list item ends a sentence. An
 * unclosed code fence holds the rest of the text back until it closes.
 *
 * A sentence is final once a later sentence holding a letter follows it, a
 * line break ends it, or its text part ends, so a period inside a number, a
 * version, or an abbreviation, such as `$3.50`, never ends a sentence
 * early; `finish()` hands out the rest, however short. A sentence is handed
 * out at most once and never taken back.
 *
 * Feed the buffer the reply's text: the snapshot at the start, then every
 * fragment as it arrives. `start` hands out every sentence; `current`
 * skips the sentences final when the snapshot loads and starts with the one
 * being written, or with the next text part when the snapshot's last text
 * part already ended. Concurrency model: single-owner.
 */
export class SpeechSentenceBuffer {
  /** Number of leading sentences handed out so far; it never decreases. */
  #handedOut = 0
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
    if (this.#start === "start") return this.#drain()
    this.#handedOut = this.#finalCount(this.#segments())
    return []
  }

  /**
   * Appends a streamed fragment of the text part being written.
   *
   * @param fragment - Fragment exactly as stored, or a new text part's
   * content after the blank line that separates it from the text before.
   * @returns The sentences the fragment made final, in order.
   */
  public push(fragment: string): string[] {
    this.#markdown += fragment
    this.#lastBlock = "open"
    return this.#drain()
  }

  /**
   * Ends the text and hands out what is left, however short.
   *
   * @returns The rest of the text as zero or one sentences; empty on a later
   * call.
   */
  public finish(): string[] {
    this.#lastBlock = "closed"
    const segments = this.#segments()
    const rest = segments
      .slice(this.#handedOut)
      .map((segment) => segment.text)
      .filter((text) => text !== "")
      .join(" ")
    this.#handedOut = Math.max(this.#handedOut, segments.length)
    return rest === "" ? [] : [rest]
  }

  /**
   * Splits the current text into sentences.
   *
   * @returns The sentences of the plain text, in order.
   */
  #segments(): SentenceSegment[] {
    const plain = toPlainText(this.#markdown, this.#lastBlock)
    return [...sentenceSegmenter.segment(plain)].map(({ segment }) => ({
      text: segment.replace(/\s+/g, " ").trim(),
      endsLine: LINE_BREAK_PATTERN.test(segment)
    }))
  }

  /**
   * Counts the leading sentences that can no longer change.
   *
   * @param segments - The sentences of the current text.
   * @returns How many leading sentences are final.
   */
  #finalCount(segments: readonly SentenceSegment[]): number {
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
  #drain(): string[] {
    const segments = this.#segments()
    const finalCount = this.#finalCount(segments)
    const fresh = segments
      .slice(this.#handedOut, finalCount)
      .map((segment) => segment.text)
      .filter((text) => text !== "")
    this.#handedOut = Math.max(this.#handedOut, finalCount)
    return fresh
  }
}

/** One sentence of the plain text. */
type SentenceSegment = Readonly<{
  /** The sentence with its whitespace collapsed and trimmed; may be empty. */
  text: string
  /** Whether a line break ends it, which no later text can undo. */
  endsLine: boolean
}>

/**
 * Converts reply markdown to the plain text voice speaks, one block per
 * line.
 *
 * @param markdown - The text to convert.
 * @param lastBlock - Whether the last block may still grow; every other
 * block, and a closed last one, ends with sentence punctuation.
 * @returns The plain text.
 */
function toPlainText(markdown: string, lastBlock: LastBlock): string {
  const tree = markdownParser.parse(markdown)
  const definitions = collectDefinitions(tree)
  const blocks: string[] = []
  for (const child of tree.children) collectBlock(child, definitions, blocks)
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
 * Cleans one block of inline text: citation markers dropped, whitespace
 * collapsed, and no space left before closing punctuation.
 *
 * @param text - Inline text of one block.
 * @returns The cleaned text, possibly empty.
 */
function cleanInline(text: string): string {
  return text
    .replace(CITATION_MARKERS, "")
    .replace(/\s+/g, " ")
    .replace(/ ([.,;:!?)\]])/g, "$1")
    .trim()
}

/**
 * Collects the link definitions of a tree.
 *
 * @param root - Parsed reply.
 * @returns Each definition's URL, keyed by its lower-cased label.
 */
function collectDefinitions(root: Root): Definitions {
  const definitions: Definitions = new Map()
  addDefinitions(root, definitions)
  return definitions
}

/**
 * Adds the link definitions of a subtree, depth-first.
 *
 * @param node - Root of the subtree.
 * @param definitions - Map that receives each definition's URL under its
 * lower-cased label.
 */
function addDefinitions(
  node: Root | RootContent,
  definitions: Definitions
): void {
  if (node.type === "definition")
    definitions.set(node.identifier.toLowerCase(), node.url)
  if (!("children" in node)) return
  for (const child of node.children) addDefinitions(child, definitions)
}

/**
 * Renders the inline content of a node as speech text.
 *
 * @param node - Inline node, or a node whose children are inline.
 * @param definitions - Link definitions of the reply.
 * @returns The words the node reads as; empty for content that is not
 * spoken.
 */
function inline(node: Root | RootContent, definitions: Definitions): string {
  switch (node.type) {
    case "text":
    case "inlineCode":
      return node.value
    case "link":
      return linkText(inlineChildren(node, definitions), node.url)
    case "linkReference": {
      const label = inlineChildren(node, definitions)
      const url = definitions.get(node.identifier.toLowerCase())
      return url === undefined ? label : linkText(label, url)
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
      return inlineChildren(node, definitions)
  }
}

/**
 * Renders a link by its text.
 *
 * @param label - The link's text, already rendered.
 * @param url - Where the link points.
 * @returns The label, or nothing when the label is the URL itself.
 */
function linkText(label: string, url: string): string {
  const normalize = (value: string) =>
    value
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/$/, "")
  return normalize(label) === normalize(url) ? "" : label
}

/**
 * Renders the inline children of a node, concatenated.
 *
 * @param node - Node whose children to render.
 * @param definitions - Link definitions of the reply.
 * @returns The children's words; empty for a node without children.
 */
function inlineChildren(
  node: Root | RootContent,
  definitions: Definitions
): string {
  if (!("children" in node)) return ""
  return node.children.map((child) => inline(child, definitions)).join("")
}

/**
 * Appends one block of speech text once cleaned, unless nothing is left.
 *
 * @param blocks - Blocks collected so far; receives the new one.
 * @param text - The block's inline text.
 */
function pushBlock(blocks: string[], text: string): void {
  const cleaned = cleanInline(text)
  if (cleaned !== "") blocks.push(cleaned)
}

/**
 * Collects one list item: nested blocks become their own blocks, and the
 * item's inline runs join into one sentence.
 *
 * @param node - The list item.
 * @param definitions - Link definitions of the reply.
 * @param blocks - Blocks collected so far; receives the item's.
 */
function collectListItem(
  node: ListItem,
  definitions: Definitions,
  blocks: string[]
): void {
  const parts: string[] = []
  for (const child of node.children) {
    if (isBlockChild(child)) collectBlock(child, definitions, blocks)
    else parts.push(inline(child, definitions))
  }
  if (parts.length > 0) pushBlock(blocks, parts.join(" "))
}

/**
 * Collects the blocks of one subtree.
 *
 * @param node - Root of the subtree.
 * @param definitions - Link definitions of the reply.
 * @param blocks - Blocks collected so far; receives the subtree's, in
 * order.
 */
function collectBlock(
  node: RootContent,
  definitions: Definitions,
  blocks: string[]
): void {
  switch (node.type) {
    case "paragraph":
    case "heading":
      pushBlock(blocks, inlineChildren(node, definitions))
      return
    case "listItem":
      collectListItem(node, definitions, blocks)
      return
    default:
      break
  }
  if (SPOKEN_SILENCED.has(node.type) || !("children" in node)) return
  for (const child of node.children) collectBlock(child, definitions, blocks)
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
