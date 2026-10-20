import type { ConversationSource } from "@lys/share"
import type { ReactElement } from "react"

import { formatSourceSite } from "../markdown-citations"

/** Properties accepted by {@link SourceLink}. */
export type SourceLinkProps = {
  /** The numbered source. */
  readonly source: ConversationSource
}

/**
 * Presents one numbered source as a link to it.
 *
 * @remarks Shows the source's number, title, and site; the link opens the
 * source in a new tab without a referrer.
 * @param props - The numbered source.
 * @returns The source link.
 */
export default function SourceLink({ source }: SourceLinkProps): ReactElement {
  return (
    <a
      className="chat-view__source"
      href={source.url}
      rel="noreferrer"
      target="_blank"
    >
      <span className="chat-view__source-number">{source.number}</span>
      <span className="chat-view__source-title">{source.title}</span>
      <span className="chat-view__source-site">
        {formatSourceSite(source.url)}
      </span>
    </a>
  )
}
