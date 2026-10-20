import { useId, type ReactElement } from "react"

import {
  formatFoundSourcesLabel,
  formatReplyControlName,
  type ReplySourcesPresentation
} from "./reply-presentation"
import SourceLink from "./SourceLink"

/** Properties accepted by {@link ReplySourceList}. */
export type ReplySourceListProps = {
  /**
   * Sources the reply cites and those its calls found without citing; at
   * least one of the two is not empty.
   */
  readonly sources: ReplySourcesPresentation
  /** One-based position of the reply among the transcript's replies. */
  readonly replyNumber: number
}

/**
 * Presents the sources under one reply.
 *
 * @remarks When the reply cites sources, they are listed in the order it
 * first cites them, in a list labelled by its visible heading
 * `Sources · N cited`. The sources its calls found without citing follow in
 * a disclosure that starts collapsed, each with the tool that found it; its
 * summary reads `N more` after cited sources, and `Sources · N found` when
 * nothing is cited, so a reply that cites nothing shows no empty list, and
 * its name adds the reply. Each list is keyed by source number. The
 * container is not a landmark, so a transcript of many replies adds no
 * repeated regions.
 * @param props - The reply's cited and found sources and its position.
 * @returns The reply's source lists.
 */
export default function ReplySourceList({
  sources,
  replyNumber
}: ReplySourceListProps): ReactElement {
  const citedHeadingId = useId()
  const foundLabel = formatFoundSourcesLabel(sources)

  return (
    <div className="chat-view__sources">
      {sources.cited.length > 0 && (
        <>
          <p className="chat-view__sources-heading" id={citedHeadingId}>
            Sources · {sources.cited.length} cited
          </p>
          <ol
            aria-labelledby={citedHeadingId}
            className="chat-view__source-list"
          >
            {sources.cited.map((source) => (
              <li key={source.number}>
                <SourceLink source={source} />
              </li>
            ))}
          </ol>
        </>
      )}
      {sources.found.length > 0 && (
        <details className="chat-view__sources-more">
          <summary
            aria-label={formatReplyControlName(foundLabel, replyNumber)}
            className="chat-view__disclosure"
          >
            {foundLabel}
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
    </div>
  )
}
