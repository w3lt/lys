import {
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode
} from "react"
import ReactMarkdown, {
  type ExtraProps,
  MarkdownHooks,
  type Components
} from "react-markdown"
import { Copy } from "lucide-react"
import { upperFirst } from "lodash"
import { Button } from "@/components/ui/button"
import { Tooltip } from "@/components/ui/tooltip"
import type { ConversationSource } from "@lys/share"
import rehypeShiki from "@shikijs/rehype"
import remarkMath from "remark-math"
import remarkGfm from "remark-gfm"
import rehypeKatex from "rehype-katex"
import { toString } from "hast-util-to-string"

import {
  buildCitationTransformer,
  CITATION_PROPERTY,
  type CitationOptions,
  formatSourceSite
} from "./markdown-citations"
import "./MarkdownMessage.scss"

/** Properties accepted by {@link MarkdownMessage}. */
type MarkdownMessageProps = {
  /** Markdown source projected into the assistant message body. */
  readonly text: string
  /** Whether generation remains active and needs a polite caret status. */
  readonly streaming: boolean
  /** Status the caret announces while generation remains active. */
  readonly generatingLabel: string
  /**
   * Numbered sources the text may cite with `[n]` markers; each marker of a
   * listed number becomes a link to its source.
   */
  readonly sources: readonly ConversationSource[]
}

/** Properties react-markdown supplies to the `code` element inside a `pre`. */
type CodeElementProps = {
  /**
   * Block code children supplied by react-markdown, as Shiki token markup
   * when the block is highlighted.
   */
  children?: ReactNode
  /** Renderer class containing an optional `language-*` marker. */
  className?: string
}

/** Properties accepted by {@link CodeBlock}. */
type CodeBlockProps = CodeElementProps & {
  /** Plain block text, without highlighting markup, that the copy button writes. */
  code: string
}

/**
 * Extracts a Markdown language marker for the code-block header.
 *
 * @param className - Renderer class list, when a language marker is present.
 * @returns The marker without `language-` and with its first letter
 * capitalized, or `Text` when absent.
 */
function getCodeLanguage(className?: string) {
  const languageClass = className
    ?.split(" ")
    .find((value) => value.startsWith("language-"))

  return upperFirst(languageClass?.slice("language-".length) || "Text")
}

/**
 * Converts a code block's plain text to copyable text without its final newline.
 *
 * @param text - Text content of the rendered `pre` node.
 * @returns Text suitable for clipboard copying.
 */
function getCodeText(text: string) {
  return text.replace(/\n$/, "")
}

/**
 * Presents one fenced code block with language metadata and copy interaction.
 *
 * @remarks The parent/renderer owns
 * code content; this component owns only transient copied feedback and its
 * reset timer. The copy button writes `code` rather than the rendered
 * children, which may be highlighting markup. Clipboard failure is
 * intentionally silent because denial by the host runtime is not converted
 * into a message. The copy button exposes
 * its current result through a polite live label; successful copied feedback
 * resets after 1,400 ms. A repeated copy clears and replaces the prior reset
 * timer, and the active timer is cleared on unmount.
 * @param props - Rendered code children, optional language marker, and the
 * plain text to copy.
 * @returns The code block header, copy control, and code content.
 */
function CodeBlock({ children, className, code }: CodeBlockProps) {
  const [copied, setCopied] = useState(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const language = getCodeLanguage(className)

  useEffect(() => {
    return () => {
      if (resetTimer.current) {
        clearTimeout(resetTimer.current)
      }
    }
  }, [])

  /**
   * Copies the rendered code and schedules transient success feedback.
   *
   * @returns A promise that settles after clipboard access succeeds or fails.
   */
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)

      if (resetTimer.current) {
        clearTimeout(resetTimer.current)
      }

      resetTimer.current = setTimeout(() => {
        setCopied(false)
        resetTimer.current = undefined
      }, 1_400)
    } catch {
      // Clipboard access may be denied by the browser or host runtime.
    }
  }

  return (
    <div className="markdown-message__code-block">
      <div className="markdown-message__code-header">
        <span>{language}</span>
        <Button
          aria-live="polite"
          aria-label={copied ? "copied" : "Copy code"}
          onClick={handleCopy}
          size="sm"
          variant="ghost"
        >
          <Copy aria-hidden="true" />
          <span>{copied ? "copied" : "copy"}</span>
        </Button>
      </div>
      <code className="markdown-message__block-code">{children}</code>
    </div>
  )
}

/**
 * Adapts react-markdown `pre` nodes to the repository code-block projection.
 *
 * @remarks The renderer supplies this
 * callback as a stable `pre` component; non-code children, or a call without
 * the source node, retain native `<pre>` output, while a code child delegates
 * to {@link CodeBlock} with the node's text content as the copy source. Only
 * the code child's props are forwarded, so the theme background and other
 * attributes Shiki sets on `pre` are dropped.
 * @param props - Renderer-provided pre children and the hast `pre` node they
 * were rendered from.
 * @returns A native pre element or the copyable code-block projection.
 */
function MarkdownPre({
  children,
  node
}: {
  /** Renderer-provided children projected into native pre or code output. */
  children?: ReactNode
} & ExtraProps) {
  if (
    Array.isArray(children) ||
    !children ||
    typeof children !== "object" ||
    !node
  ) {
    return <pre>{children}</pre>
  }

  const codeElement = children as React.ReactElement<CodeElementProps>

  if (codeElement.type !== "code") {
    return <pre>{children}</pre>
  }

  return <CodeBlock {...codeElement.props} code={getCodeText(toString(node))} />
}

/**
 * Reports whether a link destination is a fragment of the current document.
 *
 * @param href - Link destination supplied by the renderer, when present.
 * @returns Whether the destination begins with `#`.
 */
function isFragmentHref(href: string | undefined): boolean {
  return href?.startsWith("#") ?? false
}

/**
 * Formats the description a citation shows while the pointer rests on it.
 *
 * @param title - Title of the cited source.
 * @param href - Address of the cited source.
 * @returns The title and the source's site.
 */
function formatCitationDescription(title: string, href: string): string {
  return `${title} · ${formatSourceSite(href)}`
}

/**
 * Adapts react-markdown links to the navigation their destination needs.
 *
 * @remarks A fragment link, such as a footnote reference or its
 * back-reference, stays in the current document: it keeps its `id`,
 * `aria-label`, and `aria-describedby`, which those links use to name and
 * reach each other. A citation, marked by {@link buildCitationTransformer},
 * opens its source in a new tab without a referrer, is named by its number
 * and then its source's title, as `1, source: Night moths`, and
 * shows the source's title and site while the pointer rests on it. Every
 * other link opens in a new tab without a referrer and renders only the
 * destination and title a Markdown link can carry. In every case the source
 * node the renderer supplies never becomes a DOM attribute.
 * @param props - Renderer-provided link children, destination, title,
 * footnote identity and accessible relationships, and the hast node they were
 * rendered from.
 * @returns The in-document, citation, or external link.
 */
function MarkdownLink({
  "aria-describedby": ariaDescribedBy,
  "aria-label": ariaLabel,
  children,
  href,
  id,
  node,
  title
}: ComponentProps<"a"> & ExtraProps) {
  const citation = node?.properties[CITATION_PROPERTY]
  if (citation !== undefined && href !== undefined && title !== undefined) {
    return (
      <Tooltip description={formatCitationDescription(title, href)}>
        <a
          aria-label={`${String(citation)}, source: ${title}`}
          className="markdown-message__citation"
          href={href}
          rel="noreferrer"
          target="_blank"
        >
          {children}
        </a>
      </Tooltip>
    )
  }

  if (isFragmentHref(href)) {
    return (
      <a
        aria-describedby={ariaDescribedBy}
        aria-label={ariaLabel}
        href={href}
        id={id}
        title={title}
      >
        {children}
      </a>
    )
  }

  return (
    <a href={href} rel="noreferrer" target="_blank" title={title}>
      {children}
    </a>
  )
}

/**
 * Builds the remark plugin entry that links a message's citations.
 *
 * @param sources - Sources the message may cite.
 * @returns {@link buildCitationTransformer} with its settings.
 */
function buildCitationPlugin(
  sources: readonly ConversationSource[]
): [typeof buildCitationTransformer, CitationOptions] {
  return [buildCitationTransformer, { sources }]
}

/**
 * Markdown renderer mappings used by every {@link MarkdownMessage}.
 *
 * @remarks Links route through {@link MarkdownLink}, which keeps footnote
 * links in the message and opens every other link in a new tab without the
 * referrer; fenced code routes through {@link MarkdownPre} for language
 * labels and copying. These mappings are presentation configuration, not
 * application state.
 */
const markdownComponents: Components = {
  a: MarkdownLink,
  pre: MarkdownPre
}

/**
 * Projects assistant Markdown into safe, accessible message presentation.
 *
 * @remarks The parent owns source text and
 * streaming state; this component owns no application state or external
 * resource. GitHub Flavored Markdown adds tables, task lists, strikethrough,
 * literal autolinks, and footnotes. Footnote and back-reference ids begin with
 * an identifier the renderer gives this message, so a footnote link reaches
 * its own message's note even when several messages number their notes the
 * same way. The visually hidden "Footnotes" heading keeps remark-rehype's
 * fixed `footnote-label` id, so every message with footnotes repeats it.
 * Each `[n]` marker in prose whose number is in `sources` becomes a numbered
 * link to that source; markers in code, math, and links, and markers of
 * other numbers, stay as written.
 * Markdown links receive the configured navigation attributes,
 * `$…$` and `$$…$$` math renders through KaTeX, code blocks receive the copy
 * interaction, and the streaming caret is a polite status announcement,
 * worded by the parent, only while `streaming` is true.
 * Shiki highlights fenced code with CSS `light-dark()` token colors from the
 * GitHub Light and GitHub Dark themes, so highlighted code follows the
 * inherited `color-scheme` without being highlighted again. Each language's
 * grammar loads the first time a message uses it and stays loaded for the
 * session. A fence naming a language Shiki does not bundle, compared
 * case-sensitively, renders as plain `text`; a fence without a language stays
 * unhighlighted. Processing is asynchronous: until a message's first pass
 * resolves, it renders as GitHub Flavored Markdown without the link, math,
 * and code-block handling. Later passes keep the previous output visible until
 * the new text is processed.
 * @param props - Markdown source, current streaming presentation state, the
 * caret's announcement, and the sources the text may cite.
 * @returns The rendered Markdown body and optional generation caret.
 */
export function MarkdownMessage({
  text,
  streaming,
  generatingLabel,
  sources
}: MarkdownMessageProps) {
  const instanceId = useId()
  const footnoteRehypeOptions = { clobberPrefix: `${instanceId}-` }
  const citationPlugin = buildCitationPlugin(sources)

  return (
    <div className="markdown-message">
      <MarkdownHooks
        components={markdownComponents}
        remarkPlugins={[remarkMath, remarkGfm, citationPlugin]}
        remarkRehypeOptions={footnoteRehypeOptions}
        rehypePlugins={[
          // Display math arrives as `pre > code`, so KaTeX must claim it
          // before Shiki treats it as a code block.
          rehypeKatex,
          [
            rehypeShiki,
            {
              themes: { dark: "github-dark", light: "github-light" },
              defaultColor: "light-dark()",
              addLanguageClass: true,
              colorsRendering: "none",
              langs: [],
              lazy: true,
              // Without a fallback, a lazily loaded unbundled language
              // rejects the pass, and MarkdownHooks rethrows it on render.
              fallbackLanguage: "text"
            }
          ]
        ]}
        fallback={
          <ReactMarkdown
            remarkPlugins={[remarkGfm, citationPlugin]}
            remarkRehypeOptions={footnoteRehypeOptions}
          >
            {text}
          </ReactMarkdown>
        }
      >
        {text}
      </MarkdownHooks>
      {streaming && (
        <span
          aria-label={generatingLabel}
          aria-live="polite"
          className="markdown-message__caret"
          data-testid="streaming-caret"
          role="status"
        />
      )}
    </div>
  )
}
