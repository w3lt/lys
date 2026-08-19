import { useEffect, useRef, useState, type ReactNode } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import { Copy } from "lucide-react"

import { Button } from "@/components/ui/button"

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
  /** Inline or block code children supplied by react-markdown. */
  children?: ReactNode
  /** Renderer class containing an optional `language-*` marker. */
  className?: string
}

/**
 * Extracts a Markdown language marker for the code-block header.
 *
 * @param className - Renderer class list, when a language marker is present.
 * @returns The marker without `language-`, or `text` when absent.
 */
function getCodeLanguage(className?: string) {
  const languageClass = className
    ?.split(" ")
    .find((value) => value.startsWith("language-"))

  return languageClass?.slice("language-".length) || "text"
}

/**
 * Converts renderer code children to copyable text without its final newline.
 *
 * @param children - Code children supplied by react-markdown.
 * @returns Text suitable for clipboard copying.
 */
function getCodeText(children: ReactNode) {
  return String(children).replace(/\n$/, "")
}

/**
 * Presents one fenced code block with language metadata and copy interaction.
 *
 * @remarks Primary category: interactive feature. The parent/renderer owns
 * code content; this component owns only transient copied feedback and its
 * reset timer. Clipboard failure is intentionally silent because denial by
 * the host runtime is not converted into a message. The copy button exposes
 * its current result through a polite live label; successful copied feedback
 * resets after 1,400 ms. A repeated copy clears and replaces the prior reset
 * timer, and the active timer is cleared on unmount.
 * @param props - Code children and optional language marker from Markdown.
 * @returns The code block header, copy control, and code content.
 */
function CodeBlock({ children, className }: CodeElementProps) {
  const [copied, setCopied] = useState(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const code = getCodeText(children)
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
 * @remarks Primary category: framework boundary. The renderer supplies this
 * callback as a stable `pre` component; non-code children retain native
 * `<pre>` output, while a code child delegates to {@link CodeBlock}.
 * @param props - Renderer-provided pre children.
 * @returns A native pre element or the copyable code-block projection.
 */
function MarkdownPre({
  children
}: {
  /** Renderer-provided children projected into native pre or code output. */
  children?: ReactNode
}) {
  if (Array.isArray(children) || !children || typeof children !== "object") {
    return <pre>{children}</pre>
  }

  const codeElement = children as React.ReactElement<CodeElementProps>

  if (codeElement.type !== "code") {
    return <pre>{children}</pre>
  }

  return <CodeBlock {...codeElement.props} />
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
 * @remarks Primary category: presentational. The parent owns source text and
 * streaming state; this component owns no application state or external
 * resource. Markdown links receive the configured external-navigation
 * attributes, code blocks receive the copy interaction, and the streaming
 * caret is a polite status announcement only while `streaming` is true.
 * @param props - Markdown source and current streaming presentation state.
 * @returns The rendered Markdown body and optional generation caret.
 */
export function MarkdownMessage({ text, streaming }: MarkdownMessageProps) {
  return (
    <div className="markdown-message">
      <ReactMarkdown components={markdownComponents}>{text}</ReactMarkdown>
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
