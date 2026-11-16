import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"
import remarkParse from "remark-parse"
import { unified } from "unified"
import type { Root, RootContent } from "mdast"

/**
 * Turns reply markdown into the plain sentences voice speaks.
 *
 * @remarks Mirrors what the renderer shows: symbols, citation markers like
 * `[1]`, code, math, tables, and bare URLs are not words, so they are not
 * spoken; formatting is dropped; a link is spoken by its text, unless the
 * text is the URL itself; each paragraph, heading, and list item ends a
 * sentence. The conversion is re-run from scratch on every change, so text
 * still being streamed can lose or gain words mid-stream; emitted sentences
 * are never taken back.
 */

/** Definitions of link references, keyed by their lower-cased label. */
type Definitions = Map<string, string>

const markdownParser = unified().use(remarkParse).use(remarkGfm).use(remarkMath)

/** Shared segmenter for English sentences. */
const sentenceSegmenter = new Intl.Segmenter("en", { granularity: "sentence" })

/** Characters that terminate a spoken sentence, followed by optional closers. */
const SENTENCE_END_PATTERN = /[.!?…]["'”’)\]]*$/

/** Citation markers the renderer shows as superscripts, such as `[1]`. */
const CITATION_MARKERS = /\[\^?\d+\]/g

/** Converts reply markdown to the plain text voice speaks. */
export function markdownToPlainText(markdown: string): string {
  return toPlainText(markdown, true)
}

/**
 * Converts reply markdown to plain text.
 *
 * @param markdown - The text to convert.
 * @param terminateFinalBlock - Whether the last block ends a sentence; a
 * streaming buffer passes `false` because that block may still grow.
 */
function toPlainText(markdown: string, terminateFinalBlock: boolean): string {
  const tree = markdownParser.parse(markdown)
  const definitions = collectDefinitions(tree)
  const blocks: string[] = []
  for (const child of tree.children) collectBlock(child, definitions, blocks)
  // Every block but the last one ends a sentence; when streaming, the last
  // block may still grow, so only finish flushes it, terminator or not.
  return blocks
    .map((block, index) =>
      (index < blocks.length - 1 || terminateFinalBlock) &&
      !SENTENCE_END_PATTERN.test(block)
        ? `${block}.`
        : block
    )
    .join("\n")
}

/**
 * Buffers reply markdown and hands out complete sentences as they appear.
 *
 * @remarks Feed the buffer the reply's text: the snapshot's text at the
 * start, then every delta as it arrives. `from=start` emits everything,
 * `from=current` skips the sentences complete when the first call happens
 * and starts with the one being written. `finish()` flushes whatever is
 * left, however short.
 */
export class SpeechSentenceBuffer {
  /** Number of segments handed out so far. */
  #emittedCount = 0
  /** Raw markdown received so far. */
  #markdown = ""
  readonly #mode: "start" | "current"

  /**
   * Creates a buffer.
   *
   * @param mode - `start` reads from the first word; `current` starts at the
   * sentence being written.
   */
  public constructor(mode: "start" | "current") {
    this.#mode = mode
  }

  /**
   * Loads the stored reply text, such as a snapshot's.
   *
   * @param markdown - Stored text of the reply, possibly unfinished.
   * @returns The sentences ready to speak now.
   */
  public loadSnapshot(markdown: string): string[] {
    this.#markdown = markdown
    if (this.#mode === "current") {
      this.#emittedCount = this.#completeCount()
      return []
    }
    return this.#drain()
  }

  /**
   * Appends a streamed fragment and returns the sentences it completed.
   *
   * @param delta - Fragment exactly as stored, with no added separator.
   */
  public push(delta: string): string[] {
    this.#markdown += delta
    return this.#drain()
  }

  /**
   * Returns the unsent remainder, however short, and ends the buffer.
   *
   * @returns Zero or one sentences.
   */
  public finish(): string[] {
    const segments = this.#trimmedSegments()
    const rest = segments
      .slice(this.#emittedCount)
      .filter((segment) => segment !== "")
      .join(" ")
      .trim()
    this.#emittedCount = segments.length
    return rest === "" ? [] : [rest]
  }

  /** The trimmed segments of the current text, in order. */
  #trimmedSegments(): string[] {
    const plain = toPlainText(this.#markdown, false)
    return [...sentenceSegmenter.segment(plain)].map((segment) =>
      normalizeWhitespace(segment.segment).trim()
    )
  }

  /** How many leading segments are complete sentences. */
  #completeCount(): number {
    let count = 0
    for (const segment of this.#trimmedSegments()) {
      if (!isSentenceEnd(segment)) break
      count += 1
    }
    return count
  }

  /** Emits every complete sentence that has not been emitted yet. */
  #drain(): string[] {
    const segments = this.#trimmedSegments()
    let count = 0
    for (const segment of segments) {
      if (!isSentenceEnd(segment)) break
      count += 1
    }
    const fresh = segments
      .slice(this.#emittedCount, count)
      .filter((segment) => segment !== "")
    this.#emittedCount = count
    return fresh
  }
}

/** Whether a segment ends with sentence-final punctuation. */
function isSentenceEnd(segment: string): boolean {
  return SENTENCE_END_PATTERN.test(segment.trimEnd())
}

/** Collapses runs of whitespace into single spaces. */
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ")
}

/** Cleans one block of inline text: citations dropped, whitespace collapsed. */
function cleanInline(text: string): string {
  return text
    .replace(CITATION_MARKERS, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?)\]])/g, "$1")
    .trim()
}

/** Records one link definition on the map, if the node is one. */
function collectDefinition(
  definitions: Definitions,
  node: Root | RootContent
): void {
  if (node.type !== "definition") return
  const identifier = (node as { identifier?: string }).identifier
  const url = (node as { url?: string }).url
  if (typeof identifier === "string" && typeof url === "string") {
    definitions.set(identifier.toLowerCase(), url)
  }
}

/** Collects link definitions, keyed by lower-cased label. */
function collectDefinitions(root: Root): Definitions {
  const definitions = new Map<string, string>()
  walk(root, (node) => {
    collectDefinition(definitions, node)
  })
  return definitions
}

/** Visits every node of the tree depth-first. */
function walk(
  node: Root | RootContent,
  visit: (node: Root | RootContent) => void
): void {
  visit(node)
  const children = (node as { children?: RootContent[] }).children
  if (Array.isArray(children)) {
    for (const child of children) walk(child, visit)
  }
}

/** Renders the inline content of a node as speech text. */
function inline(node: Root | RootContent, definitions: Definitions): string {
  switch (node.type) {
    case "text": {
      return (node as { value: string }).value
    }
    case "inlineCode": {
      return (node as { value: string }).value
    }
    case "link": {
      const link = node as unknown as { url: string; children: RootContent[] }
      return linkText(inlineChildren(node, definitions), link.url)
    }
    case "linkReference": {
      const reference = node as unknown as {
        identifier: string
        children: RootContent[]
      }
      const label = inlineChildren(node, definitions)
      const url = definitions.get(reference.identifier.toLowerCase())
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
    default: {
      const children = (node as { children?: RootContent[] }).children
      return children ? inlineChildren(node, definitions) : ""
    }
  }
}

/** Renders a link: its text, or nothing for a bare URL. */
function linkText(label: string, url: string): string {
  const normalize = (value: string) =>
    value
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/$/, "")
  return normalize(label) === normalize(url) ? "" : label
}

/** Renders the inline children of a node, concatenated. */
function inlineChildren(
  node: Root | RootContent,
  definitions: Definitions
): string {
  const children = (node as { children?: RootContent[] }).children ?? []
  return children.map((child) => inline(child, definitions)).join("")
}

/** Appends one block of speech text, once cleaned and non-empty. */
function pushBlock(blocks: string[], text: string): void {
  const cleaned = cleanInline(text)
  if (cleaned !== "") blocks.push(cleaned)
}

/** Collects the blocks of one subtree into `blocks`. */
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
    case "listItem": {
      const parts: string[] = []
      for (const child of node.children) {
        if (child.type === "list") collectBlock(child, definitions, blocks)
        else if (isBlockChild(child)) collectBlock(child, definitions, blocks)
        else parts.push(inline(child, definitions))
      }
      if (parts.length > 0) pushBlock(blocks, parts.join(" "))
      return
    }
    case "list":
    case "blockquote":
      for (const child of node.children)
        collectBlock(child, definitions, blocks)
      return
    case "table":
    case "code":
    case "math":
    case "html":
    case "yaml":
    case "definition":
    case "footnoteDefinition":
    case "thematicBreak":
      return
    default:
      if ("children" in node && Array.isArray(node.children)) {
        for (const child of node.children)
          collectBlock(child as RootContent, definitions, blocks)
      }
      return
  }
}

/** Whether a list-item child is a block rather than inline content. */
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
