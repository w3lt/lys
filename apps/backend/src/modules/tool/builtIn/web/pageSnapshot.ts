import type { Page } from "playwright-core"
import * as z from "zod"

/**
 * Most UTF-16 code units of one page Lys reads, inclusive: the HTML built
 * from a rendered page, or the text of a plain-text page. A longer page is
 * cut, so only its beginning is read.
 */
export const MAXIMUM_PAGE_TEXT_LENGTH = 4 * 1024 * 1024

/**
 * Most DOM nodes a page's snapshot may have to be read, inclusive.
 *
 * @remarks Text and element nodes together; a large encyclopedia article has
 * about 60,000.
 */
export const MAXIMUM_SNAPSHOT_NODES = 120_000

/** Node type of a DOM element. */
const ELEMENT_NODE = 1

/** Node type of a DOM text node. */
const TEXT_NODE = 3

/** Node type of a DOM document. */
const DOCUMENT_NODE = 9

/** Node type of a DOM document fragment, which a shadow root is. */
const DOCUMENT_FRAGMENT_NODE = 11

/** String index that stands for no string. */
const NO_STRING_INDEX = -1

/** Elements written without content or an end tag. */
const VOID_ELEMENTS: ReadonlySet<string> = new Set([
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

/** Elements left out with everything inside them: none holds page text. */
const LEFT_OUT_ELEMENTS: ReadonlySet<string> = new Set([
  "iframe",
  "noscript",
  "script",
  "style",
  "svg",
  "template"
])

/** Finds an attribute name that can be written in HTML. */
const WRITABLE_ATTRIBUTE_NAME_PATTERN = /^[^\s"'>/=\p{Cc}]+$/u

/** Validates indexes into the snapshot's string table. */
const stringIndexSchema = z.int().min(NO_STRING_INDEX)

/** Validates data present only on some nodes, by node index. */
const rareStringDataSchema = z
  .object({
    /** Indexes of the nodes that have the data. */
    index: z.array(z.int().nonnegative()).readonly(),
    /** String index of each node's value. */
    value: z.array(stringIndexSchema).readonly()
  })
  .readonly()

/** Validates the DOM nodes of one document, in tree order. */
const nodeTreeSnapshotSchema = z
  .object({
    /** Index of each node's parent, or -1 for the document. */
    parentIndex: z.array(z.int().min(-1)).readonly(),
    /** DOM node type of each node. */
    nodeType: z.array(z.int()).readonly(),
    /** String index of each node's name, uppercase for HTML elements. */
    nodeName: z.array(stringIndexSchema).readonly(),
    /** String index of each node's value, such as a text node's text. */
    nodeValue: z.array(stringIndexSchema).readonly(),
    /** String indexes of each node's attributes: name, value, name, value. */
    attributes: z.array(z.array(stringIndexSchema).readonly()).readonly(),
    /** Mode of each shadow root, present only on shadow roots. */
    shadowRootType: rareStringDataSchema.optional()
  })
  .readonly()
  .refine(
    (nodes) =>
      [
        nodes.parentIndex,
        nodes.nodeName,
        nodes.nodeValue,
        nodes.attributes
      ].every((values) => values.length === nodes.nodeType.length),
    "Every node array must have one entry per node."
  )

/**
 * Validates the part of a Chrome `DOMSnapshot.captureSnapshot` result Lys
 * reads.
 *
 * @remarks The browser makes the snapshot from outside the page's scripts,
 * but its result is still parsed before Lys trusts it. Fields Lys does not
 * read are dropped.
 */
const pageSnapshotSchema = z
  .object({
    /** Documents of the page; the first is the page itself, then its frames. */
    documents: z
      .array(z.object({ nodes: nodeTreeSnapshotSchema }).readonly())
      .min(1)
      .readonly(),
    /** String table every string index points into. */
    strings: z.array(z.string()).readonly()
  })
  .readonly()

/** What a rendered page's DOM looked like at one moment. */
export type PageSnapshot = z.infer<typeof pageSnapshotSchema>

/** DOM nodes of one snapshot document. */
type SnapshotNodes = PageSnapshot["documents"][number]["nodes"]

/** Outcome of building HTML from a page's snapshot. */
export type VisibleHtmlResult =
  | Readonly<{
      /** The HTML was built. */
      status: "built"
      /** HTML of the page, at most {@link MAXIMUM_PAGE_TEXT_LENGTH} long. */
      html: string
      /** Whether the HTML was cut and only its beginning is kept. */
      isTruncated: boolean
    }>
  | Readonly<{
      /** The page has more than {@link MAXIMUM_SNAPSHOT_NODES} nodes. */
      status: "too-complex"
    }>

/** One snapshot document arranged for writing it out. */
type SnapshotTree = Readonly<{
  /** The document's nodes. */
  nodes: SnapshotNodes
  /** String table of the snapshot. */
  strings: readonly string[]
  /** Children of each node, in the browser's flat tree order. */
  childIndexes: readonly (readonly number[])[]
  /** Indexes of the nodes that are shadow roots. */
  shadowRootIndexes: ReadonlySet<number>
}>

/** One step of writing a tree out: a node, or the end tag of an element. */
type HtmlStep =
  | Readonly<{ kind: "node"; index: number }>
  | Readonly<{ kind: "end-tag"; name: string }>

/** What writing one step produces. */
type HtmlStepOutput = Readonly<{
  /** HTML the step writes. */
  html: string
  /** Steps that follow, in document order. */
  nextSteps: readonly HtmlStep[]
}>

/** Output of a step that writes nothing. */
const EMPTY_STEP_OUTPUT: HtmlStepOutput = Object.freeze({
  html: "",
  nextSteps: Object.freeze([])
})

/**
 * Takes a snapshot of a rendered page.
 *
 * @param page - Page that finished rendering, borrowed; its browser must stay
 * open until this settles.
 * @returns The page's DOM at that moment, validated.
 * @throws When the browser fails or returns a malformed snapshot.
 * @remarks Stops the page's scripts first, so nothing changes the DOM after
 * the snapshot is taken; the page cannot run any script again. The
 * DevTools session it opens ends with the page.
 */
export async function getPageSnapshot(page: Page): Promise<PageSnapshot> {
  const session = await page.context().newCDPSession(page)
  await session.send("Emulation.setScriptExecutionDisabled", { value: true })
  const snapshot = await session.send("DOMSnapshot.captureSnapshot", {
    computedStyles: []
  })
  return pageSnapshotSchema.parse(snapshot)
}

/**
 * Reads one string of the snapshot's string table.
 *
 * @param strings - String table.
 * @param index - String index, or -1 for none.
 * @returns The string, or an empty string for -1.
 * @throws When the index is past the table, which only a malformed snapshot
 * has.
 */
function readSnapshotString(strings: readonly string[], index: number): string {
  if (index === NO_STRING_INDEX) return ""
  const value = strings[index]
  if (value === undefined) {
    throw new RangeError("A page snapshot names a string it does not have")
  }
  return value
}

/**
 * Escapes text for an HTML text node.
 *
 * @param text - Text as the DOM holds it.
 * @returns The text with `&`, `<`, and `>` escaped.
 */
function formatHtmlText(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
}

/**
 * Escapes text for a double-quoted HTML attribute value.
 *
 * @param value - Value as the DOM holds it.
 * @returns The value with `&` and `"` escaped.
 */
function formatHtmlAttributeValue(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;")
}

/**
 * Formats the attributes of one element.
 *
 * @param tree - Snapshot document.
 * @param index - Index of the element.
 * @returns ` name="value"` for each attribute whose name can be written,
 * in DOM order; an empty string when it has none.
 */
function formatHtmlAttributes(tree: SnapshotTree, index: number): string {
  const attributeIndexes = tree.nodes.attributes[index] ?? []
  const attributes: string[] = []
  for (
    let position = 0;
    position + 1 < attributeIndexes.length;
    position += 2
  ) {
    const name = readSnapshotString(
      tree.strings,
      attributeIndexes[position] ?? NO_STRING_INDEX
    )
    const value = readSnapshotString(
      tree.strings,
      attributeIndexes[position + 1] ?? NO_STRING_INDEX
    )
    if (WRITABLE_ATTRIBUTE_NAME_PATTERN.test(name)) {
      attributes.push(` ${name}="${formatHtmlAttributeValue(value)}"`)
    }
  }
  return attributes.join("")
}

/**
 * Lists the children of every node of a snapshot document.
 *
 * @param nodes - The document's nodes, in the browser's flat tree order:
 * a host's shadow root holds its rendered content, and slotted light
 * children sit inside their slot.
 * @returns For each node, its children in that order.
 */
function listChildIndexes(
  nodes: SnapshotNodes
): readonly (readonly number[])[] {
  const childIndexes: number[][] = nodes.nodeType.map(() => [])
  nodes.parentIndex.forEach((parent, index) =>
    childIndexes[parent]?.push(index)
  )
  return childIndexes
}

/**
 * Arranges one snapshot document for writing it out.
 *
 * @param snapshot - Validated snapshot.
 * @returns The page's own document with each node's children.
 */
function buildSnapshotTree(snapshot: PageSnapshot): SnapshotTree {
  const [document] = snapshot.documents
  if (document === undefined) {
    throw new RangeError("A page snapshot has no document")
  }
  const shadowRootIndexes: ReadonlySet<number> = new Set(
    document.nodes.shadowRootType?.index ?? []
  )
  return Object.freeze({
    nodes: document.nodes,
    strings: snapshot.strings,
    childIndexes: listChildIndexes(document.nodes),
    shadowRootIndexes
  })
}

/**
 * Lists the steps that write a node's children.
 *
 * @param tree - Snapshot document.
 * @param index - Index of the node.
 * @returns One node step per child, in the order they are written.
 */
function listChildSteps(tree: SnapshotTree, index: number): HtmlStep[] {
  return (tree.childIndexes[index] ?? []).map((child) => ({
    kind: "node",
    index: child
  }))
}

/**
 * Writes one element.
 *
 * @param tree - Snapshot document.
 * @param index - Index of the element.
 * @returns Its start tag, then its children and end tag; nothing for an
 * element that is left out or a pseudo-element.
 */
function formatElementStep(tree: SnapshotTree, index: number): HtmlStepOutput {
  const name = readSnapshotString(
    tree.strings,
    tree.nodes.nodeName[index] ?? NO_STRING_INDEX
  ).toLowerCase()
  if (LEFT_OUT_ELEMENTS.has(name) || name.startsWith("::")) {
    return EMPTY_STEP_OUTPUT
  }
  const startTag = `<${name}${formatHtmlAttributes(tree, index)}>`
  if (VOID_ELEMENTS.has(name)) {
    return Object.freeze({ html: startTag, nextSteps: Object.freeze([]) })
  }
  const endTag: HtmlStep = Object.freeze({ kind: "end-tag", name })
  const nextSteps = Object.freeze([...listChildSteps(tree, index), endTag])
  return Object.freeze({ html: startTag, nextSteps })
}

/**
 * Writes one node.
 *
 * @param tree - Snapshot document.
 * @param index - Index of the node.
 * @returns Its HTML and the steps that follow it.
 */
function formatNodeStep(tree: SnapshotTree, index: number): HtmlStepOutput {
  switch (tree.nodes.nodeType[index]) {
    case ELEMENT_NODE:
      return formatElementStep(tree, index)
    case TEXT_NODE: {
      const text = readSnapshotString(
        tree.strings,
        tree.nodes.nodeValue[index] ?? NO_STRING_INDEX
      )
      return Object.freeze({
        html: formatHtmlText(text),
        nextSteps: Object.freeze([])
      })
    }
    case DOCUMENT_NODE:
      return Object.freeze({ html: "", nextSteps: listChildSteps(tree, index) })
    case DOCUMENT_FRAGMENT_NODE:
      return tree.shadowRootIndexes.has(index)
        ? Object.freeze({ html: "", nextSteps: listChildSteps(tree, index) })
        : EMPTY_STEP_OUTPUT
    default:
      return EMPTY_STEP_OUTPUT
  }
}

/**
 * Writes one step.
 *
 * @param tree - Snapshot document.
 * @param step - A node, or an element's end tag.
 * @returns What the step writes and the steps that follow it.
 */
function formatHtmlStep(tree: SnapshotTree, step: HtmlStep): HtmlStepOutput {
  switch (step.kind) {
    case "node":
      return formatNodeStep(tree, step.index)
    case "end-tag":
      return Object.freeze({
        html: `</${step.name}>`,
        nextSteps: Object.freeze([])
      })
  }
}

/**
 * Cuts a page's text to its limit without splitting a surrogate pair.
 *
 * @param text - HTML or plain text longer than
 * {@link MAXIMUM_PAGE_TEXT_LENGTH}.
 * @returns Its beginning, at most that long.
 */
export function formatCutPageText(text: string): string {
  const cut = text.slice(0, MAXIMUM_PAGE_TEXT_LENGTH)
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut
}

/**
 * Builds HTML from a page's snapshot.
 *
 * @param snapshot - Validated snapshot of the page.
 * @returns The page's own document as HTML, without scripts, styles,
 * `<noscript>`, templates, SVG, iframes, comments, or pseudo-elements, and
 * with each shadow root's content inside its host and slotted content
 * inside its slot, as the page renders them; cut at
 * {@link MAXIMUM_PAGE_TEXT_LENGTH}. `too-complex` when the page has more
 * than {@link MAXIMUM_SNAPSHOT_NODES} nodes.
 * @remarks Walks the tree with its own stack, so nesting depth cannot
 * exhaust the call stack.
 */
export function buildVisibleHtml(snapshot: PageSnapshot): VisibleHtmlResult {
  const tree = buildSnapshotTree(snapshot)
  if (tree.nodes.nodeType.length > MAXIMUM_SNAPSHOT_NODES) {
    return Object.freeze({ status: "too-complex" })
  }
  const pendingSteps: HtmlStep[] = [{ kind: "node", index: 0 }]
  const parts: string[] = []
  let length = 0
  for (
    let step = pendingSteps.pop();
    step !== undefined;
    step = pendingSteps.pop()
  ) {
    const output = formatHtmlStep(tree, step)
    parts.push(output.html)
    length += output.html.length
    if (length > MAXIMUM_PAGE_TEXT_LENGTH) {
      return Object.freeze({
        status: "built",
        html: formatCutPageText(parts.join("")),
        isTruncated: true
      })
    }
    pendingSteps.push(...[...output.nextSteps].reverse())
  }
  return Object.freeze({
    status: "built",
    html: parts.join(""),
    isTruncated: false
  })
}
