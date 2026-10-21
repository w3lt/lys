// Page script of the reader. dump_dom.py evaluates this file in the page, in
// a script world of the reader's own that the page's scripts cannot reach,
// once the page has loaded and its virtual time has ended. The value of the
// last statement is the HTML the reader writes.

/**
 * Lists the nodes the page renders as a node's children.
 *
 * @param node - Node of the page's document.
 * @returns For an element with an open shadow root, the root's children; for a
 * `<slot>` that has nodes assigned to it, those nodes; otherwise the node's own
 * children, which for a `<slot>` are its fallback content and for the host of a
 * closed shadow root, which no script can read, its light children.
 */
function listRenderedChildNodes(node) {
  if (node instanceof Element && node.shadowRoot !== null) {
    return node.shadowRoot.childNodes
  }
  if (node instanceof HTMLSlotElement) {
    const assignedNodes = node.assignedNodes()
    if (assignedNodes.length > 0) return assignedNodes
  }
  return node.childNodes
}

/**
 * Builds a copy of an element and its descendants as the page renders them.
 *
 * @param sourceRoot - Element of the page's document.
 * @returns A copy of `sourceRoot` in a new inert HTML document, not inserted
 * in it, whose descendants are copies of the nodes
 * {@link listRenderedChildNodes} lists, each node copied once with its
 * attributes. Light children that no slot shows are left out, and a
 * `<template>` is copied without its content. The page's document is not
 * changed.
 * @remarks The inert document has no browsing context, so nothing in the copy
 * runs a script, defines a custom element, or loads a resource. The tree is
 * walked with a stack rather than by recursion, so no nesting depth can
 * exhaust the call stack.
 */
function buildFlattenedCopy(sourceRoot) {
  const flatDocument =
    sourceRoot.ownerDocument.implementation.createHTMLDocument("")
  const flatRoot = flatDocument.importNode(sourceRoot, false)
  const pendingCopies = [{ source: sourceRoot, copy: flatRoot }]
  while (pendingCopies.length > 0) {
    const { source, copy } = pendingCopies.pop()
    for (const child of listRenderedChildNodes(source)) {
      const childCopy = copy.appendChild(flatDocument.importNode(child, false))
      pendingCopies.push({ source: child, copy: childCopy })
    }
  }
  return flatRoot
}

/**
 * Answers whether an element or one of its descendants has an open shadow
 * root.
 *
 * @param rootElement - Element of the page's document.
 * @returns Whether a script can read the shadow root of `rootElement` or of an
 * element below it in the document. A shadow root inside a closed one is not
 * looked for, because no script can reach its host.
 */
function hasOpenShadowRootInTree(rootElement) {
  const elementWalker = rootElement.ownerDocument.createTreeWalker(
    rootElement,
    NodeFilter.SHOW_ELEMENT
  )
  for (
    let element = elementWalker.currentNode;
    element !== null;
    element = elementWalker.nextNode()
  ) {
    if (element.shadowRoot !== null) return true
  }
  return false
}

/**
 * Builds the HTML of a document as the page renders it.
 *
 * @param sourceDocument - The page's document.
 * @returns The doctype on a line of its own when the document has one, then
 * the HTML of the root element, with U+FFFD in place of each lone UTF-16
 * surrogate so the text can be written as UTF-8; an empty string when the
 * document has no root element. When an element has an open shadow root, the
 * root element's HTML is that of {@link buildFlattenedCopy}'s copy, written by
 * the browser's HTML serializer. Otherwise it is the page's own `outerHTML`,
 * as `--dump-dom` writes it.
 * @remarks Only a page with an open shadow root pays for the copy, which
 * needs about four times the renderer memory that `outerHTML` needs.
 */
function buildFlattenedPageHtml(sourceDocument) {
  const rootElement = sourceDocument.documentElement
  if (rootElement === null) return ""
  const doctypeLine =
    sourceDocument.doctype === null
      ? ""
      : `${new XMLSerializer().serializeToString(sourceDocument.doctype)}\n`
  const rootHtml = hasOpenShadowRootInTree(rootElement)
    ? buildFlattenedCopy(rootElement).outerHTML
    : rootElement.outerHTML
  return (doctypeLine + rootHtml).toWellFormed()
}

buildFlattenedPageHtml(document)
