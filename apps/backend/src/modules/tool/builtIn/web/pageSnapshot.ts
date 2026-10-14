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

/**
 * Computed styles the snapshot reports for every rendered node, in this
 * order; what decides whether a person can see a text.
 */
const PAGE_SNAPSHOT_STYLES = Object.freeze([
  "visibility",
  "opacity",
  "color",
  "background-color",
  "background-image",
  "overflow-x",
  "overflow-y"
] as const)

/** One computed style the snapshot reports. */
type PageSnapshotStyle = (typeof PAGE_SNAPSHOT_STYLES)[number]

/**
 * Fewest CSS pixels of width and of height, inclusive, a text must show to
 * count as visible; a clipped one-pixel box hides its text.
 */
const MINIMUM_VISIBLE_TEXT_SIZE_PX = 2

/**
 * Largest difference, inclusive, in every RGB channel (0 to 255) between a
 * text's color and its background at which the text counts as invisible.
 */
const MAXIMUM_INVISIBLE_COLOR_DIFFERENCE = 16

/** Overflow values that cut off content outside an element's box. */
const CLIPPING_OVERFLOW_VALUES: ReadonlySet<string> = new Set([
  "hidden",
  "clip"
])

/** Finds the channels of a computed `rgb()` or `rgba()` color. */
const RGB_COLOR_PATTERN =
  /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/

/** Finds a text made only of whitespace. */
const WHITESPACE_ONLY_PATTERN = /^\s*$/

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

/** Validates the layout boxes of one document's rendered nodes. */
const layoutTreeSnapshotSchema = z
  .object({
    /** Index of the node each layout box belongs to. */
    nodeIndex: z.array(z.int().nonnegative()).readonly(),
    /**
     * String indexes of each box's computed styles, in the order Lys asked
     * for them.
     */
    styles: z.array(z.array(stringIndexSchema).readonly()).readonly(),
    /** Each box as x, y, width, and height, in CSS pixels of the page. */
    bounds: z
      .array(
        z.tuple([z.number(), z.number(), z.number(), z.number()]).readonly()
      )
      .readonly()
  })
  .readonly()
  .refine(
    (layout) =>
      layout.styles.length === layout.nodeIndex.length &&
      layout.bounds.length === layout.nodeIndex.length,
    "Every layout array must have one entry per box."
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
      .array(
        z
          .object({
            nodes: nodeTreeSnapshotSchema,
            layout: layoutTreeSnapshotSchema
          })
          .readonly()
      )
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

/** Layout boxes of one snapshot document. */
type SnapshotLayout = PageSnapshot["documents"][number]["layout"]

/** A color as its sRGB channels, 0 to 255, and its alpha, 0 to 1. */
type RgbColor = Readonly<{
  red: number
  green: number
  blue: number
  alpha: number
}>

/** Rectangle of the page, in CSS pixels; an unbounded side is infinite. */
type ClipRect = Readonly<{
  left: number
  top: number
  right: number
  bottom: number
}>

/** What a text is drawn on. */
type TextBackdrop =
  | Readonly<{
      /** A color, the nearest one that is not transparent. */
      kind: "color"
      /** The color. */
      color: RgbColor
    }>
  | Readonly<{
      /** An image, whose colors the snapshot does not give. */
      kind: "image"
    }>

/** What each node passes on to its descendants about their visibility. */
type VisibilityContext = Readonly<{
  /** Whether the node is the page's `<body>` or inside it. */
  isInBody: boolean
  /** Product of the opacity of the node and its ancestors, 0 to 1. */
  opacity: number
  /** Part of the page the node's descendants can be seen in. */
  clip: ClipRect
  /** What the node's text is drawn on. */
  backdrop: TextBackdrop
}>

/** Context of the document: the whole page, opaque, on white. */
const DOCUMENT_VISIBILITY_CONTEXT: VisibilityContext = Object.freeze({
  isInBody: false,
  opacity: 1,
  clip: Object.freeze({
    left: 0,
    top: 0,
    right: Number.POSITIVE_INFINITY,
    bottom: Number.POSITIVE_INFINITY
  }),
  backdrop: Object.freeze({
    kind: "color",
    color: Object.freeze({ red: 255, green: 255, blue: 255, alpha: 1 })
  })
})

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
  /** Layout boxes of the document. */
  layout: SnapshotLayout
  /** Index of each rendered node's layout box, by node index. */
  layoutIndexes: ReadonlyMap<number, number>
  /** Visibility context of each node, by node index. */
  visibilityContexts: readonly VisibilityContext[]
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
    computedStyles: [...PAGE_SNAPSHOT_STYLES]
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
 * @returns The page's own document with each node's children, layout box,
 * and visibility context.
 */
function buildSnapshotTree(snapshot: PageSnapshot): SnapshotTree {
  const [document] = snapshot.documents
  if (document === undefined) {
    throw new RangeError("A page snapshot has no document")
  }
  const shadowRootIndexes: ReadonlySet<number> = new Set(
    document.nodes.shadowRootType?.index ?? []
  )
  const layoutIndexes: ReadonlyMap<number, number> = new Map(
    document.layout.nodeIndex.map((node, layoutIndex) => [node, layoutIndex])
  )
  const tree: SnapshotTree = Object.freeze({
    nodes: document.nodes,
    strings: snapshot.strings,
    childIndexes: listChildIndexes(document.nodes),
    shadowRootIndexes,
    layout: document.layout,
    layoutIndexes,
    visibilityContexts: Object.freeze([])
  })
  return Object.freeze({
    ...tree,
    visibilityContexts: listVisibilityContexts(tree)
  })
}

/**
 * Reads one computed style of a rendered node.
 *
 * @param tree - Snapshot document.
 * @param layoutIndex - Index of the node's layout box.
 * @param style - Style to read.
 * @returns The style's computed value, or an empty string when the
 * snapshot gives none.
 */
function readLayoutStyle(
  tree: SnapshotTree,
  layoutIndex: number,
  style: PageSnapshotStyle
): string {
  const styleIndexes = tree.layout.styles[layoutIndex] ?? []
  return readSnapshotString(
    tree.strings,
    styleIndexes[PAGE_SNAPSHOT_STYLES.indexOf(style)] ?? NO_STRING_INDEX
  )
}

/**
 * Parses a computed color.
 *
 * @param value - Computed `color` or `background-color` value.
 * @returns Its channels, or undefined for a color not written as `rgb()` or
 * `rgba()`, such as a wide-gamut color.
 */
function parseRgbColor(value: string): RgbColor | undefined {
  const match = RGB_COLOR_PATTERN.exec(value)
  if (match === null) return undefined
  return Object.freeze({
    red: Number(match[1]),
    green: Number(match[2]),
    blue: Number(match[3]),
    alpha: match[4] === undefined ? 1 : Number(match[4])
  })
}

/**
 * Parses a computed opacity.
 *
 * @param value - Computed `opacity`, or an empty string when the snapshot
 * gives none, as for the document.
 * @returns The opacity from 0 to 1; 1, CSS's initial value, when the value
 * is absent or not a number.
 */
function parseOpacity(value: string): number {
  const opacity = value === "" ? Number.NaN : Number(value)
  return Number.isFinite(opacity) ? opacity : 1
}

/**
 * Narrows the part of the page an element's content can be seen in.
 *
 * @param clip - Part its parent's content can be seen in.
 * @param bounds - Element's box: x, y, width, height.
 * @param overflow - Element's computed `overflow-x` and `overflow-y`.
 * @returns The part cut to the element's box on each axis whose overflow
 * hides content; an axis that scrolls or shows its overflow is not cut.
 */
function calculateContentClip(
  clip: ClipRect,
  bounds: readonly [number, number, number, number],
  overflow: Readonly<{ x: string; y: string }>
): ClipRect {
  const [x, y, width, height] = bounds
  const isXClipped = CLIPPING_OVERFLOW_VALUES.has(overflow.x)
  const isYClipped = CLIPPING_OVERFLOW_VALUES.has(overflow.y)
  return Object.freeze({
    left: isXClipped ? Math.max(clip.left, x) : clip.left,
    top: isYClipped ? Math.max(clip.top, y) : clip.top,
    right: isXClipped ? Math.min(clip.right, x + width) : clip.right,
    bottom: isYClipped ? Math.min(clip.bottom, y + height) : clip.bottom
  })
}

/**
 * Finds what a rendered element's text is drawn on.
 *
 * @param tree - Snapshot document.
 * @param layoutIndex - Index of the element's layout box.
 * @param parentBackdrop - What its parent's text is drawn on.
 * @returns An image when the element has a background image, its
 * background color when that is not transparent, else the parent's.
 */
function findTextBackdrop(
  tree: SnapshotTree,
  layoutIndex: number,
  parentBackdrop: TextBackdrop
): TextBackdrop {
  if (readLayoutStyle(tree, layoutIndex, "background-image") !== "none") {
    return Object.freeze({ kind: "image" })
  }
  const color = parseRgbColor(
    readLayoutStyle(tree, layoutIndex, "background-color")
  )
  if (color === undefined || color.alpha === 0) return parentBackdrop
  return Object.freeze({ kind: "color", color })
}

/**
 * Builds the visibility context one node passes on.
 *
 * @param tree - Snapshot document.
 * @param index - Index of the node.
 * @param parent - Context of the node's parent.
 * @returns For a rendered element, the parent's context with the element's
 * opacity, overflow clip, and background; for any other node, such as the
 * document, whose layout box has no styles, the parent's. Either is marked
 * as inside `<body>` from the body element on.
 */
function buildVisibilityContext(
  tree: SnapshotTree,
  index: number,
  parent: VisibilityContext
): VisibilityContext {
  const name = readSnapshotString(
    tree.strings,
    tree.nodes.nodeName[index] ?? NO_STRING_INDEX
  )
  const isInBody = parent.isInBody || name === "BODY"
  const layoutIndex =
    tree.nodes.nodeType[index] === ELEMENT_NODE
      ? tree.layoutIndexes.get(index)
      : undefined
  const bounds =
    layoutIndex === undefined ? undefined : tree.layout.bounds[layoutIndex]
  if (layoutIndex === undefined || bounds === undefined) {
    return isInBody === parent.isInBody
      ? parent
      : Object.freeze({ ...parent, isInBody })
  }
  const overflow = Object.freeze({
    x: readLayoutStyle(tree, layoutIndex, "overflow-x"),
    y: readLayoutStyle(tree, layoutIndex, "overflow-y")
  })
  const opacity = parseOpacity(readLayoutStyle(tree, layoutIndex, "opacity"))
  return Object.freeze({
    isInBody,
    opacity: parent.opacity * opacity,
    clip: calculateContentClip(parent.clip, bounds, overflow),
    backdrop: findTextBackdrop(tree, layoutIndex, parent.backdrop)
  })
}

/**
 * Lists the visibility context of every node of a snapshot document.
 *
 * @param tree - Snapshot document; its contexts are not read.
 * @returns Each node's context, built from its parent's, by node index.
 * Nodes come in tree order, so a parent's context is ready first.
 */
function listVisibilityContexts(
  tree: SnapshotTree
): readonly VisibilityContext[] {
  const contexts: VisibilityContext[] = []
  tree.nodes.nodeType.forEach((_nodeType, index) => {
    const parent = tree.nodes.parentIndex[index] ?? -1
    const parentContext = contexts[parent] ?? DOCUMENT_VISIBILITY_CONTEXT
    contexts.push(buildVisibilityContext(tree, index, parentContext))
  })
  return Object.freeze(contexts)
}

/**
 * Answers whether a text box shows enough of itself to be read.
 *
 * @param bounds - Text's box: x, y, width, height.
 * @param clip - Part of the page the text can be seen in.
 * @returns True when the box, cut to that part, is at least
 * {@link MINIMUM_VISIBLE_TEXT_SIZE_PX} wide and high.
 */
function isTextBoxLargeEnough(
  bounds: readonly [number, number, number, number],
  clip: ClipRect
): boolean {
  const [x, y, width, height] = bounds
  const visibleWidth = Math.min(clip.right, x + width) - Math.max(clip.left, x)
  const visibleHeight =
    Math.min(clip.bottom, y + height) - Math.max(clip.top, y)
  return (
    visibleWidth >= MINIMUM_VISIBLE_TEXT_SIZE_PX &&
    visibleHeight >= MINIMUM_VISIBLE_TEXT_SIZE_PX
  )
}

/**
 * Answers whether a text's color stands out from what it is drawn on.
 *
 * @param color - Text color, or undefined when it cannot be judged.
 * @param backdrop - What the text is drawn on.
 * @returns False only when the backdrop is a color and every channel of the
 * text color is within {@link MAXIMUM_INVISIBLE_COLOR_DIFFERENCE} of it.
 */
function isColorDistinct(
  color: RgbColor | undefined,
  backdrop: TextBackdrop
): boolean {
  if (color === undefined || backdrop.kind === "image") return true
  return [
    color.red - backdrop.color.red,
    color.green - backdrop.color.green,
    color.blue - backdrop.color.blue
  ].some(
    (difference) => Math.abs(difference) > MAXIMUM_INVISIBLE_COLOR_DIFFERENCE
  )
}

/**
 * Answers whether a person can see one text node of the page.
 *
 * @param tree - Snapshot document.
 * @param index - Index of the text node.
 * @param text - Its text.
 * @returns True outside `<body>`, for whitespace, and for text that has a
 * layout box, `visibility: visible`, a color that is not transparent, an
 * opacity above 0 through its ancestors, at least 2 by 2 pixels left once
 * cut by every `overflow: hidden` or `clip` ancestor and the page's top and
 * left edges, and a color that stands out from its background.
 * @remarks Every value comes from the browser's layout, so the page's
 * scripts cannot change the answer. Text covered by another element and
 * text hidden by `clip-path` are not detected.
 */
function isTextNodeVisible(
  tree: SnapshotTree,
  index: number,
  text: string
): boolean {
  const context = tree.visibilityContexts[index] ?? DOCUMENT_VISIBILITY_CONTEXT
  if (!context.isInBody || WHITESPACE_ONLY_PATTERN.test(text)) return true
  const layoutIndex = tree.layoutIndexes.get(index)
  const bounds =
    layoutIndex === undefined ? undefined : tree.layout.bounds[layoutIndex]
  if (layoutIndex === undefined || bounds === undefined) return false
  if (readLayoutStyle(tree, layoutIndex, "visibility") !== "visible")
    return false
  const color = parseRgbColor(readLayoutStyle(tree, layoutIndex, "color"))
  if (color?.alpha === 0 || context.opacity <= 0) return false
  return (
    isTextBoxLargeEnough(bounds, context.clip) &&
    isColorDistinct(color, context.backdrop)
  )
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
      if (!isTextNodeVisible(tree, index, text)) return EMPTY_STEP_OUTPUT
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
