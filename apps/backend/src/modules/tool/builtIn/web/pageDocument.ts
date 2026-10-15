import type { CDPSession, Page } from "playwright-core"
import * as z from "zod"
import { formatCutText } from "./untrustedText"

/**
 * Most UTF-16 code units of one page Lys reads, inclusive: the HTML built
 * from a rendered page, or the text of a plain-text page. A longer page is
 * cut, so only its beginning is read.
 */
export const MAXIMUM_PAGE_TEXT_LENGTH = 4 * 1024 * 1024

/** How Lys reads a page: as HTML, or as plain text. */
export type PageMediaType = "text/html" | "text/plain"

/** The document a page shows, as Lys reads it. */
export type PageDocument = Readonly<{
  /**
   * URL of the document, as the browser gives it; untrusted until it passes
   * the page URL rules.
   */
  url: string
  /** Media type the browser gave the document, such as `text/html`. */
  contentType: string
  /**
   * HTTP status of the response that delivered the document; 0 when the
   * browser built the document without one.
   */
  responseStatus: number
  /**
   * For HTML, the document's HTML; for plain text, its text; empty for any
   * other media type. At most {@link MAXIMUM_PAGE_TEXT_LENGTH} long.
   */
  text: string
  /** Whether the text was longer and only its beginning is kept. */
  isTruncated: boolean
}>

/** What the page script reads from the document, before Lys trusts it. */
const pageScriptDocumentSchema = z
  .object({
    /** URL of the document. */
    url: z.string(),
    /** Media type the browser gave the document. */
    contentType: z.string(),
    /** HTTP status of the document's response, or 0 for none. */
    responseStatus: z.int().min(0).max(999),
    /** HTML or text of the document, at most one code unit past the limit. */
    text: z.string().max(MAXIMUM_PAGE_TEXT_LENGTH + 1),
    /** Whether the document's HTML or text was longer than the limit. */
    isTruncated: z.boolean()
  })
  .strict()
  .readonly()

/** What the page script reads from the document. */
type PageScriptDocument = z.infer<typeof pageScriptDocumentSchema>

/** HTML or text the page script read, and whether it was cut. */
type PageScriptText = Readonly<{
  /** HTML or text, at most one code unit past the limit. */
  text: string
  /** Whether there was more than the limit. */
  isTruncated: boolean
}>

/** What the page script needs to know, passed to it as its argument. */
type PageScriptSettings = Readonly<{
  /** {@link MAXIMUM_PAGE_TEXT_LENGTH}. */
  maximumTextLength: number
  /** Media types read as HTML. */
  htmlMediaTypes: readonly string[]
  /** Media type read as plain text. */
  plainTextMediaType: string
  /** Elements left out with everything inside them. */
  leftOutElements: readonly string[]
  /** Elements written without content or an end tag. */
  voidElements: readonly string[]
  /** Attributes left out of every element. */
  leftOutAttributes: readonly string[]
}>

/**
 * Finds the error DevTools gives when the document a script world belonged
 * to was replaced, as by a `<meta>` refresh, before or while the page script
 * ran in it. DevTools gives only this text, so only this adapter reads it.
 */
const REPLACED_DOCUMENT_ERROR_PATTERN =
  /\((?:Page\.createIsolatedWorld|Runtime\.callFunctionOn)\): (?:Cannot find context with specified id|Execution context was destroyed\.)$/m

/**
 * Global object of the page script's own world, as far as the script reads
 * it.
 *
 * @remarks Describes the browser's DOM contract, whose typings the backend
 * does not load. Only the page script uses it.
 */
interface PageScriptWindow {
  /** Document the page shows. */
  get document(): PageScriptDocumentNode
  /** Timing records of the page. */
  get performance(): PageScriptPerformance
}

/** Timing records of the page, as far as the page script reads them. */
interface PageScriptPerformance {
  /**
   * Lists the records of one type.
   *
   * @param type - Record type, such as `navigation`.
   * @returns The records, oldest first.
   */
  getEntriesByType(type: string): ArrayLike<PageScriptNavigationEntry>
}

/** Navigation record of a document, as far as the page script reads it. */
interface PageScriptNavigationEntry {
  /** HTTP status of the response that delivered the document; 0 for none. */
  get responseStatus(): number
}

/** Node of the page's DOM, as far as the page script reads it. */
interface PageScriptNode {
  /** DOM node type, which the node's own constants name. */
  get nodeType(): number
  /** Node type of an element. */
  get ELEMENT_NODE(): number
  /** Node type of a text node. */
  get TEXT_NODE(): number
  /** Node type of a document. */
  get DOCUMENT_NODE(): number
  /** Child nodes in document order. */
  get childNodes(): ArrayLike<PageScriptNode>
}

/** Document of the page, as far as the page script reads it. */
interface PageScriptDocumentNode extends PageScriptNode {
  /** URL of the document. */
  get URL(): string
  /** Media type the browser gave the document. */
  get contentType(): string
  /** Body of the document, or null when it has none. */
  get body(): PageScriptBody | null
}

/** Body of a document, as far as the page script reads it. */
interface PageScriptBody extends PageScriptNode {
  /** Text of the body and its descendants. */
  get textContent(): string | null
}

/** Text node of the page, as far as the page script reads it. */
interface PageScriptTextNode extends PageScriptNode {
  /** Its text. */
  get data(): string
}

/** Attribute of an element, as far as the page script reads it. */
interface PageScriptAttribute {
  /** Qualified name. */
  get name(): string
  /** Value. */
  get value(): string
}

/** Element of the page, as far as the page script reads it. */
interface PageScriptElement extends PageScriptNode {
  /** Tag name, lowercase for HTML elements. */
  get localName(): string
  /** Attributes in DOM order. */
  get attributes(): ArrayLike<PageScriptAttribute>
  /**
   * Its open shadow root; null when it has none or its root is closed, which
   * no script outside the element can read.
   */
  get shadowRoot(): PageScriptNode | null
}

/** Slot of a shadow root, as far as the page script reads it. */
interface PageScriptSlot extends PageScriptElement {
  /**
   * Lists the light content slotted into it.
   *
   * @returns The assigned nodes in order; empty when none are.
   */
  assignedNodes(): ArrayLike<PageScriptNode>
}

/** DevTools call argument that passes the page script its settings. */
type PageScriptArgument = Readonly<{
  /** Settings, sent by value. */
  value: PageScriptSettings
}>

/** One step of writing the DOM out: a node, or the end tag of an element. */
type PageScriptStep =
  | Readonly<{
      /** Write a node. */
      kind: "node"
      /** The node. */
      node: PageScriptNode
    }>
  | Readonly<{
      /** Write an element's end tag. */
      kind: "end-tag"
      /** Lowercase tag name. */
      name: string
    }>

/** What writing one step produces. */
type PageScriptStepOutput = Readonly<{
  /** HTML the step writes. */
  html: string
  /** Steps that follow, in document order. */
  nextSteps: readonly PageScriptStep[]
}>

/** Media types Lys reads, mapped to how it reads them. */
const PAGE_MEDIA_TYPES: ReadonlyMap<string, PageMediaType> = new Map([
  ["text/html", "text/html"],
  ["application/xhtml+xml", "text/html"],
  ["text/plain", "text/plain"]
])

/** Media types read as HTML. */
const HTML_MEDIA_TYPES: readonly string[] = Object.freeze(
  [...PAGE_MEDIA_TYPES]
    .filter(([, pageMediaType]) => pageMediaType === "text/html")
    .map(([mediaType]) => mediaType)
)

/** Elements left out with everything inside them: none holds page text. */
const LEFT_OUT_ELEMENTS: readonly string[] = Object.freeze([
  "iframe",
  "noscript",
  "script",
  "style",
  "svg",
  "template"
])

/** Elements written without content or an end tag. */
const VOID_ELEMENTS: readonly string[] = Object.freeze([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr"
])

/**
 * Attributes left out of every element: the main-text extraction would drop
 * an element they hide, and Lys reads hidden text as well.
 */
const LEFT_OUT_ATTRIBUTES: readonly string[] = Object.freeze([
  "aria-hidden",
  "hidden",
  "style"
])

/** Settings of every page script run. */
const PAGE_SCRIPT_SETTINGS: PageScriptSettings = Object.freeze({
  maximumTextLength: MAXIMUM_PAGE_TEXT_LENGTH,
  htmlMediaTypes: HTML_MEDIA_TYPES,
  plainTextMediaType: "text/plain",
  leftOutElements: LEFT_OUT_ELEMENTS,
  voidElements: VOID_ELEMENTS,
  leftOutAttributes: LEFT_OUT_ATTRIBUTES
})

/** Argument of every page script run: its settings, passed by value. */
const PAGE_SCRIPT_ARGUMENT: PageScriptArgument = Object.freeze({
  value: PAGE_SCRIPT_SETTINGS
})

/** Name of the script world Lys reads the page's document in. */
const PAGE_SCRIPT_WORLD_NAME = "lys-read-page"

/**
 * Finds how Lys reads a media type.
 *
 * @param mediaType - Lowercase media type without parameters.
 * @returns HTML or plain text, or undefined for a media type Lys does not
 * read.
 */
export function findPageMediaType(
  mediaType: string
): PageMediaType | undefined {
  return PAGE_MEDIA_TYPES.get(mediaType)
}

/**
 * Answers whether a node of the page is an element.
 *
 * @param node - Node of the page.
 * @returns True for an element node with the members
 * {@link PageScriptElement} names.
 * @remarks Runs in the page; see {@link PAGE_SCRIPT_DECLARATION}.
 */
function isPageScriptElement(node: PageScriptNode): node is PageScriptElement {
  return (
    node.nodeType === node.ELEMENT_NODE &&
    "localName" in node &&
    "attributes" in node &&
    "shadowRoot" in node
  )
}

/**
 * Answers whether a node of the page is a shadow root's slot.
 *
 * @param node - Node of the page.
 * @returns True for a `<slot>` element that can list its slotted content.
 * @remarks Runs in the page; see {@link PAGE_SCRIPT_DECLARATION}.
 */
function isPageScriptSlot(node: PageScriptNode): node is PageScriptSlot {
  return (
    isPageScriptElement(node) &&
    node.localName === "slot" &&
    "assignedNodes" in node &&
    typeof node.assignedNodes === "function"
  )
}

/**
 * Answers whether a node of the page is a text node.
 *
 * @param node - Node of the page.
 * @returns True for a text node with its text.
 * @remarks Runs in the page; see {@link PAGE_SCRIPT_DECLARATION}.
 */
function isPageScriptTextNode(
  node: PageScriptNode
): node is PageScriptTextNode {
  return (
    node.nodeType === node.TEXT_NODE &&
    "data" in node &&
    typeof node.data === "string"
  )
}

/**
 * Lists the children of a node as the page renders them.
 *
 * @param node - Node of the page.
 * @returns For an element with an open shadow root, the root's children;
 * for a slot with light content slotted into it, that content; otherwise
 * the node's own children.
 * @remarks Runs in the page; see {@link PAGE_SCRIPT_DECLARATION}.
 */
function listPageScriptChildNodes(
  node: PageScriptNode
): readonly PageScriptNode[] {
  if (isPageScriptElement(node) && node.shadowRoot !== null) {
    return Array.from(node.shadowRoot.childNodes)
  }
  const assignedNodes = isPageScriptSlot(node)
    ? Array.from(node.assignedNodes())
    : []
  return assignedNodes.length > 0 ? assignedNodes : Array.from(node.childNodes)
}

/**
 * Builds the steps that write a node's children.
 *
 * @param node - Node of the page.
 * @returns One node step per child, in the order
 * {@link listPageScriptChildNodes} lists them.
 * @remarks Runs in the page; see {@link PAGE_SCRIPT_DECLARATION}.
 */
function buildPageScriptChildSteps(
  node: PageScriptNode
): readonly PageScriptStep[] {
  return Object.freeze(
    listPageScriptChildNodes(node).map((child): PageScriptStep =>
      Object.freeze({ kind: "node", node: child })
    )
  )
}

/**
 * Builds the output of a step that writes HTML and nothing after it.
 *
 * @param html - HTML the step writes.
 * @returns The output, with no steps following.
 * @remarks Runs in the page; see {@link PAGE_SCRIPT_DECLARATION}.
 */
function buildPageScriptLeafOutput(html: string): PageScriptStepOutput {
  const nextSteps: readonly PageScriptStep[] = Object.freeze([])
  return Object.freeze({ html, nextSteps })
}

/**
 * Escapes text for an HTML text node.
 *
 * @param text - Text as the DOM holds it.
 * @returns The text with `&`, `<`, and `>` escaped.
 * @remarks Runs in the page; see {@link PAGE_SCRIPT_DECLARATION}.
 */
function formatPageScriptText(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
}

/**
 * Formats the attributes of one element.
 *
 * @param element - Element of the page.
 * @param remainingLength - Most code units the page's HTML may still grow
 * by; each value is cut to it before it is escaped.
 * @param settings - Attributes to leave out.
 * @returns ` name="value"` for each attribute whose name can be written and
 * is not left out, in DOM order; an empty string when there is none.
 * @remarks Runs in the page; see {@link PAGE_SCRIPT_DECLARATION}.
 */
function formatPageScriptAttributes(
  element: PageScriptElement,
  remainingLength: number,
  settings: PageScriptSettings
): string {
  const writableNamePattern = /^[^\s"'>/=\p{Cc}]+$/u
  const attributes: string[] = []
  for (const attribute of Array.from(element.attributes)) {
    const { name } = attribute
    if (settings.leftOutAttributes.includes(name)) continue
    if (!writableNamePattern.test(name)) continue
    const value = attribute.value
      .slice(0, remainingLength)
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
    attributes.push(` ${name}="${value}"`)
  }
  return attributes.join("")
}

/**
 * Writes one element.
 *
 * @param element - Element of the page.
 * @param remainingLength - Most code units the page's HTML may still grow
 * by.
 * @param settings - Elements and attributes to leave out, and void
 * elements.
 * @returns Its start tag, then its children and end tag; nothing for an
 * element that is left out.
 * @remarks Runs in the page; see {@link PAGE_SCRIPT_DECLARATION}.
 */
function formatPageScriptElement(
  element: PageScriptElement,
  remainingLength: number,
  settings: PageScriptSettings
): PageScriptStepOutput {
  const name = element.localName.toLowerCase()
  if (settings.leftOutElements.includes(name)) {
    return buildPageScriptLeafOutput("")
  }
  const attributes = formatPageScriptAttributes(
    element,
    remainingLength,
    settings
  )
  const startTag = `<${name}${attributes}>`
  if (settings.voidElements.includes(name)) {
    return buildPageScriptLeafOutput(startTag)
  }
  const endTag: PageScriptStep = Object.freeze({ kind: "end-tag", name })
  const nextSteps = Object.freeze([
    ...buildPageScriptChildSteps(element),
    endTag
  ])
  return Object.freeze({ html: startTag, nextSteps })
}

/**
 * Writes one node.
 *
 * @param node - Node of the page.
 * @param remainingLength - Most code units the page's HTML may still grow
 * by; a text is cut to it before it is escaped.
 * @param settings - What to leave out.
 * @returns For an element, its start tag and the steps that follow; for a
 * text, its escaped text; for the document, its children; nothing for any
 * other node, such as a comment.
 * @remarks Runs in the page; see {@link PAGE_SCRIPT_DECLARATION}.
 */
function formatPageScriptNode(
  node: PageScriptNode,
  remainingLength: number,
  settings: PageScriptSettings
): PageScriptStepOutput {
  if (isPageScriptElement(node)) {
    return formatPageScriptElement(node, remainingLength, settings)
  }
  if (isPageScriptTextNode(node)) {
    const text = node.data.slice(0, remainingLength)
    return buildPageScriptLeafOutput(formatPageScriptText(text))
  }
  if (node.nodeType !== node.DOCUMENT_NODE) {
    return buildPageScriptLeafOutput("")
  }
  const nextSteps = buildPageScriptChildSteps(node)
  return Object.freeze({ html: "", nextSteps })
}

/**
 * Writes one step.
 *
 * @param step - A node, or an element's end tag.
 * @param remainingLength - Most code units the page's HTML may still grow
 * by.
 * @param settings - What to leave out.
 * @returns What the step writes and the steps that follow it.
 * @remarks Runs in the page; see {@link PAGE_SCRIPT_DECLARATION}.
 */
function formatPageScriptStep(
  step: PageScriptStep,
  remainingLength: number,
  settings: PageScriptSettings
): PageScriptStepOutput {
  switch (step.kind) {
    case "node":
      return formatPageScriptNode(step.node, remainingLength, settings)
    case "end-tag":
      return buildPageScriptLeafOutput(`</${step.name}>`)
  }
}

/**
 * Builds the HTML of the page's DOM.
 *
 * @param document - Document of the page.
 * @param settings - Limit and what to leave out.
 * @returns The HTML of the document in the order the page renders it, at
 * most one code unit past the limit, and whether it was longer than the
 * limit. The walk stops as soon as it passes the limit, and every text and
 * attribute value is cut before it is escaped, so the page's size never
 * bounds the work or the result.
 * @remarks Runs in the page; see {@link PAGE_SCRIPT_DECLARATION}. Walks the
 * tree with its own stack, so nesting depth cannot exhaust the call stack.
 */
function buildPageScriptHtml(
  document: PageScriptDocumentNode,
  settings: PageScriptSettings
): PageScriptText {
  const rootStep: PageScriptStep = Object.freeze({
    kind: "node",
    node: document
  })
  const pendingSteps: PageScriptStep[] = [rootStep]
  const parts: string[] = []
  let length = 0
  for (
    let step = pendingSteps.pop();
    step !== undefined;
    step = pendingSteps.pop()
  ) {
    const remainingLength = settings.maximumTextLength + 1 - length
    const output = formatPageScriptStep(step, remainingLength, settings)
    const html = output.html.slice(0, remainingLength)
    parts.push(html)
    length += html.length
    if (length > settings.maximumTextLength) {
      return Object.freeze({ text: parts.join(""), isTruncated: true })
    }
    for (const nextStep of [...output.nextSteps].reverse()) {
      pendingSteps.push(nextStep)
    }
  }
  return Object.freeze({ text: parts.join(""), isTruncated: false })
}

/**
 * Reads the text of a plain-text document.
 *
 * @param document - Document of the page.
 * @param settings - Limit.
 * @returns The body's text, at most one code unit past the limit, and
 * whether it was longer than the limit.
 * @remarks Runs in the page; see {@link PAGE_SCRIPT_DECLARATION}.
 */
function buildPageScriptPlainText(
  document: PageScriptDocumentNode,
  settings: PageScriptSettings
): PageScriptText {
  const text = document.body?.textContent ?? ""
  return Object.freeze({
    text: text.slice(0, settings.maximumTextLength + 1),
    isTruncated: text.length > settings.maximumTextLength
  })
}

/**
 * Reads the HTML or text of the document, by its media type.
 *
 * @param document - Document of the page.
 * @param settings - Media types, limit, and what to leave out.
 * @returns HTML for an HTML document, text for a plain-text one, and
 * nothing for any other.
 * @remarks Runs in the page; see {@link PAGE_SCRIPT_DECLARATION}.
 */
function buildPageScriptText(
  document: PageScriptDocumentNode,
  settings: PageScriptSettings
): PageScriptText {
  if (settings.htmlMediaTypes.includes(document.contentType)) {
    return buildPageScriptHtml(document, settings)
  }
  if (document.contentType === settings.plainTextMediaType) {
    return buildPageScriptPlainText(document, settings)
  }
  return Object.freeze({ text: "", isTruncated: false })
}

/**
 * Reads the document the page shows.
 *
 * @param window - Global object of the page script's world.
 * @param settings - Media types, limit, and what to leave out.
 * @returns The document's URL, its media type, the HTTP status of its
 * response, and its HTML or text.
 * @remarks Runs in the page; see {@link PAGE_SCRIPT_DECLARATION}.
 */
function buildPageScriptDocument(
  window: PageScriptWindow,
  settings: PageScriptSettings
): PageScriptDocument {
  const { document } = window
  const [navigation] = Array.from(
    window.performance.getEntriesByType("navigation")
  )
  const content = buildPageScriptText(document, settings)
  return Object.freeze({
    url: document.URL,
    contentType: document.contentType,
    responseStatus: navigation?.responseStatus ?? 0,
    text: content.text,
    isTruncated: content.isTruncated
  })
}

/**
 * Source of the function Lys runs in the page to read its document: every
 * page script function, then a call of {@link buildPageScriptDocument}
 * with the world's global object and the settings it is passed.
 *
 * @remarks Each function runs in the page, so it uses only its parameters,
 * the other page script functions, and the language's own globals; no
 * module value exists there. None declares a named function or binds a
 * function to a name inside its body, because the backend's development
 * runtime adds a naming helper to such functions that only exists in Node.
 */
const PAGE_SCRIPT_DECLARATION = `function (settings) {
${[
  isPageScriptElement,
  isPageScriptSlot,
  isPageScriptTextNode,
  listPageScriptChildNodes,
  buildPageScriptChildSteps,
  buildPageScriptLeafOutput,
  formatPageScriptText,
  formatPageScriptAttributes,
  formatPageScriptElement,
  formatPageScriptNode,
  formatPageScriptStep,
  buildPageScriptHtml,
  buildPageScriptPlainText,
  buildPageScriptText,
  buildPageScriptDocument
]
  .map(String)
  .join("\n")}
return ${buildPageScriptDocument.name}(globalThis, settings)
}`

/**
 * Answers whether a DevTools call failed because the document it addressed
 * was replaced.
 *
 * @param error - What the call rejected with.
 * @returns True for the errors {@link REPLACED_DOCUMENT_ERROR_PATTERN} finds.
 */
function isReplacedDocumentError(error: unknown): boolean {
  return (
    error instanceof Error &&
    REPLACED_DOCUMENT_ERROR_PATTERN.test(error.message)
  )
}

/**
 * Sends the page script to the document the page shows, in a new script
 * world of its own.
 *
 * @param session - DevTools session of the page.
 * @returns What DevTools answered: the script's result or its exception.
 * @throws When the browser fails, the replaced-document error included.
 */
async function sendPageScriptCall(session: CDPSession) {
  const { frameTree } = await session.send("Page.getFrameTree")
  const world = await session.send("Page.createIsolatedWorld", {
    frameId: frameTree.frame.id,
    worldName: PAGE_SCRIPT_WORLD_NAME
  })
  return session.send("Runtime.callFunctionOn", {
    functionDeclaration: PAGE_SCRIPT_DECLARATION,
    executionContextId: world.executionContextId,
    arguments: [PAGE_SCRIPT_ARGUMENT],
    returnByValue: true
  })
}

/**
 * Finds the document the page shows by running the page script in it.
 *
 * @param session - DevTools session of the page, whose scripts are stopped.
 * @returns The document, with its text cut at {@link MAXIMUM_PAGE_TEXT_LENGTH}
 * without splitting a character; undefined when the page replaced its
 * document before the script could run, so there is a new one to read.
 * @throws When the browser fails otherwise, the script fails in the page,
 * or its result is malformed.
 */
async function findPageDocument(
  session: CDPSession
): Promise<PageDocument | undefined> {
  const [call] = await Promise.allSettled([sendPageScriptCall(session)])
  if (call?.status === "rejected") {
    if (isReplacedDocumentError(call.reason)) return undefined
    throw call.reason
  }
  if (call?.value.exceptionDetails !== undefined) {
    throw new Error("Reading the page's document failed inside the page", {
      cause: call.value.exceptionDetails
    })
  }
  const pageScriptDocument = pageScriptDocumentSchema.parse(
    call?.value.result.value
  )
  const text = formatCutText(pageScriptDocument.text, MAXIMUM_PAGE_TEXT_LENGTH)
  return Object.freeze({
    url: pageScriptDocument.url,
    contentType: pageScriptDocument.contentType,
    responseStatus: pageScriptDocument.responseStatus,
    text,
    isTruncated: pageScriptDocument.isTruncated
  })
}

/**
 * Reads the document a rendered page shows.
 *
 * @param page - Page whose document has arrived, borrowed; its browser must
 * stay open until this settles.
 * @returns The document's URL, media type, and HTTP status, and its HTML or
 * text cut to {@link MAXIMUM_PAGE_TEXT_LENGTH} without splitting a
 * character. HTML is written from the page's DOM as it renders: an open
 * shadow root's content inside its host and slotted content inside its slot,
 * without scripts, styles, `<noscript>`, templates, SVG, iframes, comments,
 * or the attributes that hide an element. Hidden text is kept.
 * @throws When the browser fails, the script fails in the page, or its
 * result is malformed.
 * @remarks Stops the page's scripts first, so no timer or script changes or
 * replaces the document any more; the page cannot run a script again. Then
 * runs one synchronous script in a world of its own, which the page's
 * scripts cannot reach. When the page replaces its document before that
 * script runs, as a `<meta>` refresh can, it reads the new one, for as long
 * as the caller waits, so a page that never holds still keeps it waiting
 * until the caller's time limit ends the wait. The script bounds the HTML and text
 * before they leave the page, so no page can make Lys receive more than the
 * limit. A closed shadow root's content cannot be read; its host's own
 * children are written instead. The DevTools session it opens ends with the
 * page.
 */
export async function getPageDocument(page: Page): Promise<PageDocument> {
  const session = await page.context().newCDPSession(page)
  await session.send("Emulation.setScriptExecutionDisabled", { value: true })
  for (;;) {
    const document = await findPageDocument(session)
    if (document !== undefined) return document
  }
}
