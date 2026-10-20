import type { ConversationSource } from "@lys/share"

import {
  CITATION_MARKER_PATTERN,
  isCitableParentNode,
  isMarkdownParentNode,
  isMarkdownTextNode,
  type MarkdownParentNode,
  type MarkdownTextNode
} from "@/lib/citation-markers"

/** Settings of {@link buildCitationTransformer}. */
export type CitationOptions = Readonly<{
  /** Numbered sources a `[n]` marker may cite; other numbers stay text. */
  sources: readonly ConversationSource[]
}>

/** Data property that marks a link as a citation of a numbered source. */
export const CITATION_PROPERTY = "dataCitation"

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
 * Builds the nodes one child becomes once the markers in its own text are
 * links.
 *
 * @param child - Child node of a parent; not changed.
 * @param sourcesByNumber - Sources that markers may cite.
 * @returns The nodes {@link buildCitedTextNodes} builds for a text node; the
 * child itself otherwise.
 */
function buildCitedChildNodes(
  child: unknown,
  sourcesByNumber: ReadonlyMap<number, ConversationSource>
): unknown[] {
  return isMarkdownTextNode(child)
    ? buildCitedTextNodes(child, sourcesByNumber)
    : [child]
}

/**
 * Turns the citation markers under a node into links.
 *
 * @param node - Parent node; its children, and those of every node below it
 * that may cite sources, are replaced in place, as remark transformers change
 * the tree they receive.
 * @param sourcesByNumber - Sources that markers may cite.
 */
function updateCitationLinks(
  node: MarkdownParentNode,
  sourcesByNumber: ReadonlyMap<number, ConversationSource>
): void {
  for (const child of node.children) {
    if (isCitableParentNode(child)) updateCitationLinks(child, sourcesByNumber)
  }
  node.children = node.children.flatMap((child) =>
    buildCitedChildNodes(child, sourcesByNumber)
  )
}

/**
 * Builds the remark transformer that turns each `[n]` marker citing a known
 * source into a link to that source; used as a remark plugin.
 *
 * @param options - Sources the markers may cite.
 * @returns A transformer that changes the Markdown tree in place: markers in
 * prose become links showing the number, titled by the source and marked with
 * {@link CITATION_PROPERTY}; markers in code, math, and existing links, and
 * markers of numbers without a source, stay as they are.
 */
export function buildCitationTransformer(
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
