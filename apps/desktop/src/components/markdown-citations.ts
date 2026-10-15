import type { ConversationSource } from "@lys/share"

/** Settings of {@link remarkCitations}. */
export type CitationOptions = Readonly<{
  /** Numbered sources a `[n]` marker may cite; other numbers stay text. */
  sources: readonly ConversationSource[]
}>

/** Markdown text node, as remark builds it. */
type MarkdownTextNode = Readonly<{
  /** Node kind. */
  type: "text"
  /** The text. */
  value: string
}>

/** Markdown node with children, as remark builds it. */
type MarkdownParentNode = {
  /** Node kind. */
  readonly type: string
  /** Child nodes, replaced when citations are found among them. */
  children: unknown[]
}

/** Parent nodes whose text is already a link, so it cites nothing. */
const LINK_NODE_TYPES: ReadonlySet<string> = new Set(["link", "linkReference"])

/**
 * Finds each `[n]` citation marker in text; its group is the number. Use it
 * with `matchAll`, which copies it, so its `lastIndex` never changes.
 */
export const CITATION_MARKER_PATTERN = /\[(\d+)\]/g

/** Data property that marks a link as a citation of a numbered source. */
export const CITATION_PROPERTY = "dataCitation"

/**
 * Answers whether a value is an object node of the Markdown tree.
 *
 * @param node - Value from the Markdown tree.
 * @returns True for a non-null object.
 */
function isMarkdownNode(
  node: unknown
): node is Readonly<Record<string, unknown>> {
  return typeof node === "object" && node !== null
}

/**
 * Answers whether a value is a Markdown node with children.
 *
 * @param node - Value from the Markdown tree.
 * @returns True for a node with a text `type` and a `children` array.
 */
function isMarkdownParentNode(node: unknown): node is MarkdownParentNode {
  return (
    isMarkdownNode(node) &&
    typeof node.type === "string" &&
    Array.isArray(node.children)
  )
}

/**
 * Answers whether a value is a Markdown text node.
 *
 * @param node - Value from the Markdown tree.
 * @returns True for a `text` node holding text.
 */
function isMarkdownTextNode(node: unknown): node is MarkdownTextNode {
  return (
    isMarkdownNode(node) &&
    node.type === "text" &&
    typeof node.value === "string"
  )
}

/**
 * Builds the link that one citation marker becomes.
 *
 * @param source - The cited source.
 * @returns A link to the source's address titled by the source, showing its
 * number and marked as a citation.
 */
function buildCitationLink(source: ConversationSource): unknown {
  return {
    type: "link",
    url: source.url,
    title: source.title,
    data: { hProperties: { [CITATION_PROPERTY]: String(source.number) } },
    children: [{ type: "text", value: String(source.number) }]
  }
}

/**
 * Builds the nodes a text node becomes once its citation markers are links.
 *
 * @param node - Text node.
 * @param sourcesByNumber - Sources that markers may cite.
 * @returns The text around each marker of a known source, and that marker's
 * link, in order; the node itself when no marker cites a known source.
 */
function buildCitedTextNodes(
  node: MarkdownTextNode,
  sourcesByNumber: ReadonlyMap<number, ConversationSource>
): unknown[] {
  const nodes: unknown[] = []
  let textStart = 0
  for (const match of node.value.matchAll(CITATION_MARKER_PATTERN)) {
    const source = sourcesByNumber.get(Number(match[1]))
    if (source === undefined) continue
    nodes.push(
      { type: "text", value: node.value.slice(textStart, match.index) },
      buildCitationLink(source)
    )
    textStart = match.index + match[0].length
  }
  if (textStart === 0) return [node]
  nodes.push({ type: "text", value: node.value.slice(textStart) })
  return nodes
}

/**
 * Builds the nodes one child becomes, turning citation markers in its text
 * into links.
 *
 * @param child - Child node of a parent.
 * @param sourcesByNumber - Sources that markers may cite.
 * @returns The nodes that replace the child; a parent child is changed in
 * place unless it is a link.
 */
function buildCitedChildNodes(
  child: unknown,
  sourcesByNumber: ReadonlyMap<number, ConversationSource>
): unknown[] {
  if (isMarkdownTextNode(child))
    return buildCitedTextNodes(child, sourcesByNumber)
  if (isMarkdownParentNode(child) && !LINK_NODE_TYPES.has(child.type))
    updateCitationLinks(child, sourcesByNumber)
  return [child]
}

/**
 * Turns the citation markers under a node into links.
 *
 * @param node - Parent node; its children are replaced in place, as remark
 * transformers change the tree they receive.
 * @param sourcesByNumber - Sources that markers may cite.
 */
function updateCitationLinks(
  node: MarkdownParentNode,
  sourcesByNumber: ReadonlyMap<number, ConversationSource>
): void {
  node.children = node.children.flatMap((child) =>
    buildCitedChildNodes(child, sourcesByNumber)
  )
}

/**
 * Remark plugin that turns each `[n]` marker citing a known source into a
 * link to that source.
 *
 * @param options - Sources the markers may cite.
 * @returns A transformer that changes the Markdown tree in place: markers in
 * prose become links showing the number, titled by the source and marked with
 * {@link CITATION_PROPERTY}; markers in code, math, and existing links, and
 * markers of numbers without a source, stay as they are.
 */
export function remarkCitations(
  options: CitationOptions
): (tree: unknown) => void {
  const sourcesByNumber = new Map(
    options.sources.map((source) => [source.number, source])
  )
  return (tree) => updateTreeCitationLinks(tree, sourcesByNumber)
}

/**
 * Turns the citation markers of a Markdown tree into links.
 *
 * @param tree - Root the transformer receives; changed in place when it has
 * children, and left alone otherwise.
 * @param sourcesByNumber - Sources that markers may cite.
 */
function updateTreeCitationLinks(
  tree: unknown,
  sourcesByNumber: ReadonlyMap<number, ConversationSource>
): void {
  if (isMarkdownParentNode(tree)) updateCitationLinks(tree, sourcesByNumber)
}

/**
 * Formats the site of a source for display.
 *
 * @param url - Source URL, an absolute `http` or `https` address.
 * @returns Its host without a leading `www.`.
 */
export function formatSourceSite(url: string): string {
  return new URL(url).host.replace(/^www\./, "")
}
