import { useId, type ReactElement, type RefObject } from "react"

import {
  formatMcpDraftProblemSummaryHeading,
  type McpDraftProblemListing
} from "./mcp-presentation"

/** Level of a summary's heading. */
type McpDraftProblemSummaryHeadingLevel = 3 | 4

/** Element of each heading level; a new level must add one. */
const SUMMARY_HEADING_TAGS = Object.freeze({
  3: "h3",
  4: "h4"
} satisfies Readonly<Record<McpDraftProblemSummaryHeadingLevel, "h3" | "h4">>)

/**
 * Properties accepted by {@link McpDraftProblemSummary}.
 *
 * @typeParam TField - Fields of the form: each listing names one, and a
 * button hands the same one back.
 */
type McpDraftProblemSummaryProps<TField extends string> = {
  /**
   * Level of the summary's heading, one below the heading of the form it
   * belongs to.
   */
  readonly headingLevel: McpDraftProblemSummaryHeadingLevel
  /** Fields with a problem, in the form's order; two or more. */
  readonly problems: readonly McpDraftProblemListing<TField>[]
  /** Host the parent moves focus to when a save is rejected. */
  readonly summaryRef: RefObject<HTMLFieldSetElement | null>
  /** Requests that the parent move focus to one field. */
  readonly onSelectField: (field: TField) => void
}

/**
 * Lists every field whose problem stopped a save, each leading to its field,
 * for the server editor and the email account card.
 *
 * @remarks The parent owns the problems, the host, and moving focus; the
 * summary owns no state. It is a group named by its heading, `Fix N fields
 * to save:`, at the level the parent gives, that takes focus only
 * programmatically. Each field is a button named by the field's label and
 * its problem, in the form's order, that asks the parent to move focus to
 * the field's control.
 * @typeParam TField - Fields of the form, which the listings name and the
 * buttons hand back.
 * @param props - Heading level, problems, the host, and the parent-owned
 * focus move.
 * @returns The summary.
 */
export function McpDraftProblemSummary<TField extends string>({
  headingLevel,
  problems,
  summaryRef,
  onSelectField
}: McpDraftProblemSummaryProps<TField>): ReactElement {
  const headingId = useId()
  const Heading = SUMMARY_HEADING_TAGS[headingLevel]

  return (
    <fieldset
      aria-labelledby={headingId}
      className="settings-view__mcp-summary"
      ref={summaryRef}
      tabIndex={-1}
    >
      <Heading id={headingId}>
        {formatMcpDraftProblemSummaryHeading(problems.length)}
      </Heading>
      <ul>
        {problems.map((listing) => (
          <McpDraftProblemItem
            key={listing.field}
            listing={listing}
            onSelectField={onSelectField}
          />
        ))}
      </ul>
    </fieldset>
  )
}

/**
 * Properties accepted by {@link McpDraftProblemItem}.
 *
 * @typeParam TField - Fields of the form: the listing names one, and the
 * button hands the same one back.
 */
type McpDraftProblemItemProps<TField extends string> = {
  /** Field and its problem. */
  readonly listing: McpDraftProblemListing<TField>
  /** Requests that the parent move focus to the field. */
  readonly onSelectField: (field: TField) => void
}

/**
 * Presents one field of the problem summary as a button leading to it.
 *
 * @remarks The list owner supplies the key; the item owns no state.
 * @typeParam TField - Fields of the form, which the listing names and the
 * button hands back.
 * @param props - Field, its problem, and the parent-owned focus move.
 * @returns One list item.
 */
function McpDraftProblemItem<TField extends string>({
  listing,
  onSelectField
}: McpDraftProblemItemProps<TField>): ReactElement {
  return (
    <li>
      <button
        className="settings-view__mcp-summary-link"
        onClick={() => onSelectField(listing.field)}
        type="button"
      >
        {listing.label}: {listing.problem}
      </button>
    </li>
  )
}
