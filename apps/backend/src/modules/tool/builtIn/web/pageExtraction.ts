import { Readability } from "@mozilla/readability"
import { parseHTML } from "linkedom"
import type { PageResponse } from "./pageRequest"

/** Kind of one block of page text. */
export type PageBlockKind = "heading" | "text"

/** One block of page text: a heading, or a paragraph-like run of text. */
export type PageBlock = Readonly<{
  /** Whether the block is a heading or text. */
  kind: PageBlockKind
  /** Non-empty text of the block, with its whitespace collapsed. */
  text: string
}>

/** Main text of a page and what is known about it. */
export type PageArticle = Readonly<{
  /** Title of the page; the page's host when it has none. */
  title: string
  /** Name of the site the page belongs to, or undefined when unknown. */
  siteName: string | undefined
  /** Publication date the page states, as written, or undefined. */
  publishedTime: string | undefined
  /** Blocks of the main text in page order; at least one. */
  blocks: readonly PageBlock[]
}>

/** Outcome of extracting the main text of a page. */
export type PageExtractionResult =
  | Readonly<{
      /** The page has readable main text. */
      status: "extracted"
      /** Main text and what is known about the page. */
      article: PageArticle
    }>
  | Readonly<{
      /**
       * The page has no main text, which usually means it needs JavaScript
       * to show its content.
       */
      status: "no-readable-text"
    }>
  | Readonly<{
      /**
       * The page has more elements than {@link MAXIMUM_PAGE_ELEMENTS}, or
       * nests them deeper than {@link MAXIMUM_PAGE_DEPTH_SUM} allows, so
       * selecting its main text would take too long.
       */
      status: "too-complex"
    }>

/** Most elements an HTML page may have to be read, inclusive. */
export const MAXIMUM_PAGE_ELEMENTS = 40_000

/**
 * Most an HTML page's element depths may add up to, inclusive, the root
 * counting 1.
 *
 * @remarks Selecting the main text takes time in proportion to this sum, and
 * it runs on the backend's only thread. At this limit it takes under a
 * second on current hardware; a large encyclopedia article sums to about
 * 350,000.
 */
export const MAXIMUM_PAGE_DEPTH_SUM = 400_000

/** DOM node type of an element. */
const ELEMENT_NODE = 1

/** DOM node type of a text node. */
const TEXT_NODE = 3

/** DOM node type of a document. */
const DOCUMENT_NODE = 9

/**
 * Elements removed before the page is read: code, styles, and inert
 * templates, whose text is never shown as page content.
 */
const NON_CONTENT_SELECTOR = "template, script, noscript, style"

/** Elements whose text forms a heading block. */
const HEADING_ELEMENTS: ReadonlySet<string> = new Set([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6"
])

/** Elements whose text forms one text block. */
const TEXT_BLOCK_ELEMENTS: ReadonlySet<string> = new Set([
  "blockquote",
  "caption",
  "dd",
  "dt",
  "figcaption",
  "li",
  "p",
  "pre",
  "summary",
  "td",
  "th"
])

/**
 * Elements that separate the loose text around them into different blocks
 * without forming a block themselves.
 */
const SEPARATING_ELEMENTS: ReadonlySet<string> = new Set([
  "article",
  "aside",
  "br",
  "details",
  "div",
  "dl",
  "fieldset",
  "figure",
  "footer",
  "form",
  "header",
  "hr",
  "main",
  "nav",
  "ol",
  "section",
  "table",
  "tbody",
  "tfoot",
  "thead",
  "tr",
  "ul"
])

/**
 * Node of the DOM linkedom builds, as far as this adapter reads it.
 *
 * @remarks Describes the external linkedom contract, whose own typings need
 * the browser DOM types the backend does not load. Only this adapter uses it.
 */
interface LinkedomNode {
  /** DOM node type, such as 1 for an element. */
  get nodeType(): number
  /** Text of the node and its descendants; null for a document. */
  get textContent(): string | null
  /** Child nodes in document order. */
  get childNodes(): Iterable<LinkedomNode>
}

/** Element of the DOM linkedom builds, as far as this adapter reads it. */
interface LinkedomElement extends LinkedomNode {
  /** Lowercase tag name. */
  get localName(): string
  /** Removes the element from its parent. */
  remove(): void
}

/** Document linkedom builds, as far as this adapter reads it. */
interface LinkedomDocument extends LinkedomNode {
  /** Root element, or null when the markup produced none. */
  get documentElement(): LinkedomElement | null
  /**
   * Finds the first element matching a selector.
   *
   * @param selectors - CSS selector list.
   * @returns The element, or null when none matches.
   */
  querySelector(selectors: string): LinkedomElement | null
  /**
   * Lists every element matching a selector.
   *
   * @param selectors - CSS selector list.
   * @returns The elements in document order, as a static list.
   */
  querySelectorAll(selectors: string): Iterable<LinkedomElement>
}

/**
 * Answers whether a value has the node members this adapter reads.
 *
 * @param value - Value from linkedom.
 * @param nodeType - DOM node type the value must have.
 * @returns True for an object of that node type with text and children.
 */
function isLinkedomNodeOfType(value: unknown, nodeType: number): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "nodeType" in value &&
    value.nodeType === nodeType &&
    "textContent" in value &&
    "childNodes" in value
  )
}

/**
 * Answers whether a value is a linkedom document.
 *
 * @param value - Document linkedom returned.
 * @returns True when it is a document node with the members
 * {@link LinkedomDocument} names.
 */
function isLinkedomDocument(value: unknown): value is LinkedomDocument {
  return (
    isLinkedomNodeOfType(value, DOCUMENT_NODE) &&
    typeof value === "object" &&
    value !== null &&
    "documentElement" in value &&
    "querySelector" in value &&
    typeof value.querySelector === "function" &&
    "querySelectorAll" in value &&
    typeof value.querySelectorAll === "function"
  )
}

/**
 * Answers whether a value is a linkedom element.
 *
 * @param value - Node linkedom or Readability returned.
 * @returns True when it is an element node with the members
 * {@link LinkedomElement} names.
 */
function isLinkedomElement(value: unknown): value is LinkedomElement {
  return (
    isLinkedomNodeOfType(value, ELEMENT_NODE) &&
    typeof value === "object" &&
    value !== null &&
    "localName" in value &&
    typeof value.localName === "string" &&
    "remove" in value &&
    typeof value.remove === "function"
  )
}

/**
 * Parses markup with linkedom.
 *
 * @param html - Markup to parse.
 * @returns The document.
 * @throws A `TypeError` when linkedom returns something other than a
 * document.
 */
function parseLinkedomDocument(html: string): LinkedomDocument {
  const { document } = parseHTML(html)
  if (!isLinkedomDocument(document)) {
    throw new TypeError("linkedom did not return a document")
  }
  return document
}

/**
 * Answers whether a document has an `<html>` root with a `<body>`.
 *
 * @param document - Parsed document.
 * @returns True when both exist.
 */
function hasDocumentBody(document: LinkedomDocument): boolean {
  return (
    document.documentElement?.localName === "html" &&
    document.querySelector("body") !== null
  )
}

/**
 * Parses page markup into a document with a body.
 *
 * @param html - Page markup.
 * @returns The document. Markup without an `<html>` root and a `<body>`,
 * which linkedom does not add as browsers do, is parsed again inside one.
 */
function parsePageDocument(html: string): LinkedomDocument {
  const document = parseLinkedomDocument(html)
  if (hasDocumentBody(document)) return document
  return parseLinkedomDocument(
    `<!doctype html><html><head></head><body>${html}</body></html>`
  )
}

/**
 * Collapses runs of whitespace into single spaces and trims the ends.
 *
 * @param text - Text to normalize.
 * @returns The normalized text.
 */
function normalizeBlockText(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

/**
 * Normalizes preformatted text, keeping its line breaks.
 *
 * @param text - Text of a `<pre>` element.
 * @returns The text with trailing spaces removed from each line and the ends
 * trimmed.
 */
function normalizePreformattedText(text: string): string {
  return text.replace(/[ \t]+\n/g, "\n").trim()
}

/**
 * Builds the block for one heading or text element.
 *
 * @param element - Heading or text element.
 * @returns The block, or undefined when the element has no text.
 */
function buildElementBlock(element: LinkedomElement): PageBlock | undefined {
  const rawText = element.textContent ?? ""
  const text =
    element.localName === "pre"
      ? normalizePreformattedText(rawText)
      : normalizeBlockText(rawText)
  if (text === "") return undefined
  const kind = HEADING_ELEMENTS.has(element.localName) ? "heading" : "text"
  const blockText = element.localName === "li" ? `- ${text}` : text
  return Object.freeze({ kind, text: blockText })
}

/** Marker that ends the loose text gathered inside a separating element. */
const SEPARATION_MARKER = Symbol("separation")

/** One step of the walk over an article's nodes. */
type ArticleWalkStep = LinkedomNode | typeof SEPARATION_MARKER

/** One thing the walk over an article finds, in page order. */
type ArticleToken =
  | Readonly<{
      /** Text outside every heading and text element. */
      kind: "loose-text"
      /** The text as it appears, whitespace not yet collapsed. */
      text: string
    }>
  | Readonly<{
      /** A heading or text element, which ends any loose text before it. */
      kind: "block"
      /** The element's block, or undefined when it has no text. */
      block: PageBlock | undefined
    }>
  | Readonly<{
      /** The start or end of a separating element. */
      kind: "separation"
    }>

/** Token that marks the start or end of a separating element. */
const SEPARATION_TOKEN: ArticleToken = Object.freeze({ kind: "separation" })

/**
 * Lists a node's children in reverse document order, for a stack.
 *
 * @param node - Node whose children are walked next.
 * @returns The children, last first.
 */
function listChildStepsInReverse(node: LinkedomNode): ArticleWalkStep[] {
  return [...node.childNodes].reverse()
}

/**
 * Lists what an article holds, in page order.
 *
 * @param article - Article element Readability returned.
 * @returns A generator of tokens; it walks the article once.
 * @remarks The walk uses its own stack, so a deeply nested page cannot
 * exhaust the call stack. A heading or text element yields one block token
 * and its descendants are not walked. A separating element yields a
 * separation before and after its descendants.
 */
function* listArticleTokens(
  article: LinkedomElement
): Generator<ArticleToken, void, undefined> {
  const pendingSteps = listChildStepsInReverse(article)
  for (
    let step = pendingSteps.pop();
    step !== undefined;
    step = pendingSteps.pop()
  ) {
    if (step === SEPARATION_MARKER) {
      yield SEPARATION_TOKEN
    } else if (isLinkedomElement(step)) {
      const { localName } = step
      if (
        HEADING_ELEMENTS.has(localName) ||
        TEXT_BLOCK_ELEMENTS.has(localName)
      ) {
        yield Object.freeze({ kind: "block", block: buildElementBlock(step) })
        continue
      }
      if (SEPARATING_ELEMENTS.has(localName)) {
        yield SEPARATION_TOKEN
        pendingSteps.push(SEPARATION_MARKER)
      }
      pendingSteps.push(...listChildStepsInReverse(step))
    } else if (step.nodeType === TEXT_NODE) {
      yield Object.freeze({ kind: "loose-text", text: step.textContent ?? "" })
    }
  }
}

/**
 * Builds the text block of a run of loose text.
 *
 * @param looseText - Loose text gathered since the last block or
 * separation.
 * @returns The block, or undefined when the text is only whitespace.
 */
function buildLooseTextBlock(looseText: string): PageBlock | undefined {
  const text = normalizeBlockText(looseText)
  return text === "" ? undefined : Object.freeze({ kind: "text", text })
}

/**
 * Builds the text blocks of an article element.
 *
 * @param article - Article element Readability returned.
 * @returns The blocks in page order. Text outside heading and text elements
 * becomes a block of its own, split wherever a block or a separating
 * element starts or ends.
 */
function buildArticleBlocks(article: LinkedomElement): readonly PageBlock[] {
  const blocks: PageBlock[] = []
  let looseText = ""
  for (const token of listArticleTokens(article)) {
    if (token.kind === "loose-text") {
      looseText += token.text
      continue
    }
    const looseBlock = buildLooseTextBlock(looseText)
    looseText = ""
    if (looseBlock !== undefined) blocks.push(looseBlock)
    if (token.kind === "block" && token.block !== undefined) {
      blocks.push(token.block)
    }
  }
  const lastLooseBlock = buildLooseTextBlock(looseText)
  if (lastLooseBlock !== undefined) blocks.push(lastLooseBlock)
  return Object.freeze(blocks)
}

/**
 * Hands Readability's article element back unchanged.
 *
 * @param node - Article element Readability built.
 * @returns The same node, so the walk can read its structure.
 */
function keepArticleNode(node: unknown): unknown {
  return node
}

/**
 * Finds the text of the first element matching a selector.
 *
 * @param document - Page document, before Readability changes it.
 * @param selectors - CSS selector of the element.
 * @returns The element's normalized text, or undefined when there is none.
 */
function findElementText(
  document: LinkedomDocument,
  selectors: string
): string | undefined {
  const text = normalizeBlockText(
    document.querySelector(selectors)?.textContent ?? ""
  )
  return text === "" ? undefined : text
}

/**
 * Converts one of Readability's optional fields into a normalized value.
 *
 * @param value - Field as Readability returned it.
 * @returns The trimmed, whitespace-collapsed text, or undefined when it is
 * empty or missing.
 */
function normalizeArticleField(
  value: string | null | undefined
): string | undefined {
  const text = normalizeBlockText(value ?? "")
  return text === "" ? undefined : text
}

/**
 * Builds the outcome for extracted blocks.
 *
 * @param article - Article whose blocks were extracted; no block is empty.
 * @returns `extracted`, or `no-readable-text` when the article has no block.
 */
function buildExtractionResult(article: PageArticle): PageExtractionResult {
  if (article.blocks.length === 0) {
    return Object.freeze({ status: "no-readable-text" })
  }
  return Object.freeze({ status: "extracted", article })
}

/**
 * Answers whether a document is small and shallow enough to read.
 *
 * @param document - Page document with its non-content elements removed.
 * @returns True when it has at most {@link MAXIMUM_PAGE_ELEMENTS} elements
 * whose depths sum to at most {@link MAXIMUM_PAGE_DEPTH_SUM}.
 * @remarks Walks with its own stack and stops as soon as a limit is passed,
 * so measuring a hostile page is cheap.
 */
function isPageStructureReadable(document: LinkedomDocument): boolean {
  const root = document.documentElement
  if (root === null) return true
  const pending: (readonly [LinkedomNode, number])[] = [[root, 1]]
  let elementCount = 0
  let depthSum = 0
  for (let entry = pending.pop(); entry !== undefined; entry = pending.pop()) {
    const [node, depth] = entry
    elementCount += 1
    depthSum += depth
    if (elementCount > MAXIMUM_PAGE_ELEMENTS) return false
    if (depthSum > MAXIMUM_PAGE_DEPTH_SUM) return false
    for (const child of node.childNodes) {
      if (child.nodeType === ELEMENT_NODE) pending.push([child, depth + 1])
    }
  }
  return true
}

/**
 * Extracts the main text of an HTML page.
 *
 * @param page - HTML page Lys read.
 * @returns The article, `no-readable-text`, or `too-complex`.
 * @throws When linkedom or Readability fail on the markup.
 */
function extractHtmlArticle(page: PageResponse): PageExtractionResult {
  const document = parsePageDocument(page.text)
  for (const element of document.querySelectorAll(NON_CONTENT_SELECTOR)) {
    element.remove()
  }
  if (!isPageStructureReadable(document)) {
    return Object.freeze({ status: "too-complex" })
  }
  const documentTitle = findElementText(document, "title")
  const parsed = new Readability<unknown>(document, {
    serializer: keepArticleNode
  }).parse()
  if (parsed === null || !isLinkedomElement(parsed.content)) {
    return Object.freeze({ status: "no-readable-text" })
  }
  const host = new URL(page.url).host
  const blocks = buildArticleBlocks(parsed.content)
  const article: PageArticle = Object.freeze({
    title: normalizeArticleField(parsed.title) ?? documentTitle ?? host,
    siteName: normalizeArticleField(parsed.siteName),
    publishedTime: normalizeArticleField(parsed.publishedTime),
    blocks
  })
  return buildExtractionResult(article)
}

/**
 * Builds the text blocks of a plain-text page.
 *
 * @param text - Page text.
 * @returns One block per paragraph, paragraphs being separated by blank
 * lines.
 */
function buildPlainTextBlocks(text: string): readonly PageBlock[] {
  return Object.freeze(
    text
      .split(/\n\s*\n/)
      .map(normalizeBlockText)
      .filter((paragraph) => paragraph !== "")
      .map((paragraph) => Object.freeze({ kind: "text", text: paragraph }))
  )
}

/**
 * Extracts the main text of a page Lys read.
 *
 * @param page - HTML or plain-text page.
 * @returns The page's title, site, publication date, and main text as
 * blocks; `no-readable-text` when the page has no main text; or, for
 * HTML, `too-complex` when the page passes {@link MAXIMUM_PAGE_ELEMENTS} or
 * {@link MAXIMUM_PAGE_DEPTH_SUM}.
 * @throws When the markup makes linkedom or Readability fail; the page is
 * then not read.
 * @remarks For HTML, scripts, styles, `<noscript>`, and `<template>`
 * elements are removed first, the page's size is checked, then Readability
 * selects the main content. No script on the page ever runs. The work is
 * synchronous; the size limits keep it under about a second. Markup that
 * puts its text outside `<body>` reads as having no text. A plain-text page
 * is titled by its host.
 */
export function extractPageArticle(page: PageResponse): PageExtractionResult {
  switch (page.mediaType) {
    case "text/html":
      return extractHtmlArticle(page)
    case "text/plain":
      return extractPlainTextArticle(page)
  }
}

/**
 * Extracts the text of a plain-text page.
 *
 * @param page - Plain-text page Lys read.
 * @returns The article, titled by the page's host, or `no-readable-text`.
 */
function extractPlainTextArticle(page: PageResponse): PageExtractionResult {
  const article: PageArticle = Object.freeze({
    title: new URL(page.url).host,
    siteName: undefined,
    publishedTime: undefined,
    blocks: buildPlainTextBlocks(page.text)
  })
  return buildExtractionResult(article)
}
