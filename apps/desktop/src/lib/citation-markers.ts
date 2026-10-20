import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"
import remarkParse from "remark-parse"
import { unified } from "unified"

/** Markdown text node, as remark builds it. */
export type MarkdownTextNode = Readonly<{
  /** Node kind. */
  type: "text"
  /** The text. */
  value: string
}>

/** Markdown node with children, as remark builds it. */
export type MarkdownParentNode = {
  /** Node kind. */
  readonly type: string
  /** Child nodes, replaced when citations are found among them. */
  children: unknown[]
}

/** Parent nodes whose text is already a link, so it cites nothing. */
const LINK_NODE_TYPES: ReadonlySet<string> = new Set(["link", "linkReference"])

/**
 * Finds each `[n]` citation marker in text; its group is the number, written
 * without leading zeros, since Lys numbers sources from 1. Use it with
 * `matchAll`, which copies it, so its `lastIndex` never changes.
 */
export const CITATION_MARKER_PATTERN = /\[([1-9]\d*)\]/g

/**
 * Parser of a reply's Markdown with the syntax extensions the reply renderer
 * uses, in its order: math, then GitHub Flavored Markdown.
 */
const replyMarkdownParser = unified()
  .use(remarkParse)
  .use(remarkMath)
  .use(remarkGfm)
  .freeze()

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
export function isMarkdownParentNode(
  node: unknown
): node is MarkdownParentNode {
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
export function isMarkdownTextNode(node: unknown): node is MarkdownTextNode {
  return (
    isMarkdownNode(node) &&
    node.type === "text" &&
    typeof node.value === "string"
  )
}

/**
 * Answers whether the text under a node may cite sources.
 *
 * @param node - Value from the Markdown tree.
 * @returns True for a node with children that is not a link; code and math
 * nodes hold their text as a value, not as text children, so they never
 * match.
 */
export function isCitableParentNode(node: unknown): node is MarkdownParentNode {
  return isMarkdownParentNode(node) && !LINK_NODE_TYPES.has(node.type)
}

/**
 * Adds the numbers of the citation markers in a node's prose to a list.
 *
 * @param node - Parent node that may cite sources; not changed.
 * @param numbers - Numbers found so far, in first-cited order; each new
 * number is added once.
 */
function addProseCitationNumbers(
  node: MarkdownParentNode,
  numbers: Set<number>
): void {
  for (const child of node.children) {
    if (isCitableParentNode(child)) addProseCitationNumbers(child, numbers)
    if (!isMarkdownTextNode(child)) continue
    for (const match of child.value.matchAll(CITATION_MARKER_PATTERN))
      numbers.add(Number(match[1]))
  }
}

/**
 * Lists the numbers of the citation markers in a reply's Markdown prose.
 *
 * @param markdown - Text the model wrote, as the reply renders it.
 * @returns Each number of a `[n]` marker in a prose text node, once, in
 * first-cited order: the markers the citation links are made from. Markers
 * in code, math, links, and link references are left out; an escaped
 * `\[1\]` reads as the prose `[1]`, so it is listed.
 */
export function listProseCitationNumbers(markdown: string): readonly number[] {
  const tree: unknown = replyMarkdownParser.parse(markdown)
  const numbers = new Set<number>()
  if (isMarkdownParentNode(tree)) addProseCitationNumbers(tree, numbers)
  return Object.freeze([...numbers])
}
