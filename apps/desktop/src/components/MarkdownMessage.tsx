import { useEffect, useRef, useState, type ReactNode } from "react"
import ReactMarkdown, {
  type ExtraProps,
  MarkdownHooks,
  type Components
} from "react-markdown"
import { Copy } from "lucide-react"
import { upperFirst } from "lodash"
import { Button } from "@/components/ui/button"
import rehypeShiki from "@shikijs/rehype"
import remarkMath from "remark-math"
import rehypeKatex from "rehype-katex"
import { toString } from "hast-util-to-string"

import "./MarkdownMessage.scss"

/** Properties accepted by {@link MarkdownMessage}. */
type MarkdownMessageProps = {
  /** Markdown source projected into the assistant message body. */
  text: string
  /** Whether generation remains active and needs a polite caret status. */
  streaming: boolean
}

/** Properties accepted by the renderer-invoked code block projection. */
type CodeElementProps = {
  /**
   * Inline or block code children supplied by react-markdown, as Shiki token
   * markup when the block's language is highlighted.
   */
  children?: ReactNode
  /** Renderer class containing an optional `language-*` marker. */
  className?: string
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
function CodeBlock({ children, className, code }: CodeElementProps) {
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
 * Markdown renderer mappings used by every {@link MarkdownMessage}.
 *
 * @remarks Links open in a new tab and omit the referrer; fenced code routes
 * through {@link MarkdownPre} for language labels and copying. These mappings
 * are presentation configuration, not application state.
 */
const markdownComponents: Components = {
  a: ({ children, ...props }) => (
    <a {...props} rel="noreferrer" target="_blank">
      {children}
    </a>
  ),
  pre: MarkdownPre
}

/**
 * Projects assistant Markdown into safe, accessible message presentation.
 *
 * @remarks The parent owns source text and
 * streaming state; this component owns no application state or external
 * resource. Markdown links receive the configured external-navigation
 * attributes, `$…$` and `$$…$$` math renders through KaTeX, code blocks
 * receive the copy interaction, and the streaming caret is a polite status
 * announcement only while `streaming` is true.
 * Fenced code in a language Shiki bundles is highlighted with GitHub Light
 * token colors; the GitHub Dark colors are exposed only as `--shiki-dark`
 * custom properties for a stylesheet to apply. Other code stays unhighlighted.
 * Processing is asynchronous. The first pass in a session loads the shared
 * Shiki highlighter with every bundled language, and until a message's first
 * pass resolves it renders as plain Markdown without the link, math, and
 * code-block handling. Later passes keep the previous output visible until
 * the new text is processed.
 * @param props - Markdown source and current streaming presentation state.
 * @returns The rendered Markdown body and optional generation caret.
 */
export function MarkdownMessage({ text, streaming }: MarkdownMessageProps) {
  return (
    <div className="markdown-message">
      <MarkdownHooks
        components={markdownComponents}
        remarkPlugins={[remarkMath]}
        rehypePlugins={[
          rehypeKatex,
          [
            rehypeShiki,
            {
              themes: { dark: "github-dark", light: "github-light" },
              defaultColor: "light-dark()",
              addLanguageClass: true
            }
          ]
        ]}
        fallback={<ReactMarkdown>{text}</ReactMarkdown>}
      >
        {text}
      </MarkdownHooks>
      {streaming && (
        <span
          aria-label="Lys is generating"
          aria-live="polite"
          className="markdown-message__caret"
          data-testid="streaming-caret"
          role="status"
        />
      )}
    </div>
  )
}
