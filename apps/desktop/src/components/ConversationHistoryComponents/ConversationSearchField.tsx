import { X } from "lucide-react"
import { useId } from "react"
import type { ReactElement } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

/** Properties accepted by {@link ConversationSearchField}. */
export type ConversationSearchFieldProps = {
  /** Current search text owned by the parent. */
  readonly searchQuery: string
  /**
   * Receives a proposed replacement for the parent-owned search text.
   *
   * The clear control proposes an empty query; it is rendered only while the
   * current query is non-empty.
   */
  readonly onSearchQueryChange: (searchQuery: string) => void
}

/**
 * Presents the controlled field that filters the conversation history.
 *
 * @remarks Primary category: presentational. The parent owns the query and
 * decides whether to accept each proposal; this component keeps no copy of it
 * and owns no state, effect, or application dependency. The field carries a
 * persistent programmatic label, and the clear control names both its action
 * and its target.
 * @param props - Parent-owned search text and its change proposal.
 * @returns The labelled search field and its clear control.
 */
export function ConversationSearchField({
  searchQuery,
  onSearchQueryChange
}: ConversationSearchFieldProps): ReactElement {
  const searchInputId = useId()

  return (
    <div className="conversation-history__search">
      <label className="sr-only" htmlFor={searchInputId}>
        Search conversations
      </label>
      <Input
        autoComplete="off"
        className="conversation-history__search-input"
        id={searchInputId}
        onChange={(event) => onSearchQueryChange(event.currentTarget.value)}
        placeholder="Search every word kept here"
        spellCheck={false}
        type="search"
        value={searchQuery}
      />
      {searchQuery !== "" && (
        <Button
          aria-label="Clear conversation search"
          className="conversation-history__search-clear"
          onClick={() => onSearchQueryChange("")}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <X aria-hidden="true" />
        </Button>
      )}
    </div>
  )
}
