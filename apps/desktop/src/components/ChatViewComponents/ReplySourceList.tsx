import type { ReactElement } from "react"

import type { ReplySourcesPresentation } from "./reply-presentation"
import SourceLink from "./SourceLink"

/** Properties accepted by {@link ReplySourceList}. */
export type ReplySourceListProps = {
  /** Sources the reply cites and those its calls found without citing. */
  readonly sources: ReplySourcesPresentation
}

/**
 * Presents the sources under one reply.
 *
 * @remarks Presentational. Lists the sources the reply cites, in the order
 * it first cites them, under `Sources · N cited`; the sources its calls
 * found without citing follow in a disclosure that starts collapsed, each
 * with the tool that found it.
 * @param props - The reply's cited and found sources.
 * @returns The labelled source list.
 */
export default function ReplySourceList({
  sources
}: ReplySourceListProps): ReactElement {
  return (
    <section aria-label="Sources" className="chat-view__sources">
      <p className="chat-view__sources-heading">
        Sources · {sources.cited.length} cited
      </p>
      <ol className="chat-view__source-list">
        {sources.cited.map((source) => (
          <li key={source.number}>
            <SourceLink source={source} />
          </li>
        ))}
      </ol>
      {sources.found.length > 0 && (
        <details className="chat-view__sources-more">
          <summary className="chat-view__disclosure">
            {sources.found.length} more
          </summary>
          <ol className="chat-view__source-list">
            {sources.found.map(({ source, toolName }) => (
              <li key={source.number}>
                <SourceLink source={source} />
                <span className="chat-view__source-via">via {toolName}</span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  )
}
