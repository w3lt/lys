import type { DocumentStatus, RecordKind } from "./status"

/**
 * Projection of handbook decisions and proposals into their generated indexes.
 *
 * Frontmatter validation in `src/content.config.ts` already requires the
 * identifying fields for these document types, but its refinement cannot narrow
 * the inferred types. This module re-checks them and fails the build with an
 * actionable message rather than rendering an index row with holes in it.
 */

/**
 * One content entry offered to the index, flattened to the fields an index row
 * needs.
 *
 * The caller resolves `href` from its own routing so this module stays
 * independent of the content loader and remains directly testable.
 */
export type HandbookRecordSource = {
  /** Site-relative address of the document. Also identifies it in errors. */
  readonly href: string
  /** Document title as authored in frontmatter. */
  readonly title: string
  /** One-sentence description shown beneath the title in list layouts. */
  readonly description?: string
  /** Stable record identifier, such as `ADR-0007`. */
  readonly identifier?: string
  /** Current status of the record. */
  readonly status?: DocumentStatus
  /**
   * Calendar date the record reached its current form, as `YYYY-MM-DD`: the
   * decision date for a decision, the creation date for a proposal.
   */
  readonly date?: string
  /**
   * Calendar date the record last changed substantively, as `YYYY-MM-DD`.
   *
   * Absent when the record has not changed since `date`.
   */
  readonly updated?: string
  /** Subsystems the record affects. */
  readonly areas?: readonly string[]
}

/** One validated row of a generated handbook index. */
export type HandbookRecord = {
  readonly identifier: string
  readonly title: string
  readonly description?: string
  readonly status: DocumentStatus
  readonly href: string
  readonly date: string
  readonly updated?: string
  readonly areas: readonly string[]
}

/**
 * Builds the validated, ordered rows of a handbook index.
 *
 * Rows are ordered by descending identifier, so a register opens on its newest
 * record. Identifiers are zero-padded and monotonic, which makes them a stable
 * ordering key that does not depend on a date a record may never restate.
 *
 * @param kind - Record type being indexed, used in failure messages.
 * @param sources - Every content entry belonging to that index, in any order.
 * @returns The index rows ordered by descending identifier.
 * @throws When a record is missing required metadata, or when two records claim
 * the same identifier. Both conditions block the build by design.
 */
export function buildRecordIndex(
  kind: RecordKind,
  sources: readonly HandbookRecordSource[]
): readonly HandbookRecord[] {
  const records = sources.map((source) => toHandbookRecord(kind, source))

  assertUniqueIdentifiers(kind, records)

  return [...records].sort((left, right) =>
    right.identifier.localeCompare(left.identifier)
  )
}

/**
 * Selects the most recently dated records, newest first.
 *
 * Used by the homepage summaries, which report current state rather than the
 * complete register.
 *
 * @param records - Index rows to select from.
 * @param count - Maximum number of rows to return. Must be positive.
 * @returns At most `count` rows, ordered by descending date.
 * @throws When `count` is not a positive integer.
 */
export function selectMostRecent(
  records: readonly HandbookRecord[],
  count: number
): readonly HandbookRecord[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(
      `A summary length must be a positive integer, got ${count}.`
    )
  }

  return [...records]
    .sort((left, right) => right.date.localeCompare(left.date))
    .slice(0, count)
}

/**
 * Counts how many records carry each status.
 *
 * Feeds the proposal index's status filters, which show their own counts.
 *
 * @param records - Index rows to tally.
 * @returns Counts keyed by status, containing only statuses actually present.
 */
export function countByStatus(
  records: readonly HandbookRecord[]
): ReadonlyMap<DocumentStatus, number> {
  const counts = new Map<DocumentStatus, number>()

  for (const record of records) {
    counts.set(record.status, (counts.get(record.status) ?? 0) + 1)
  }

  return counts
}

/**
 * Validates one content entry and narrows it to an index row.
 *
 * @param kind - Record type being indexed, used in failure messages.
 * @param source - The content entry to validate.
 * @returns The validated index row.
 * @throws When `identifier`, `status`, or `date` is missing.
 */
function toHandbookRecord(
  kind: RecordKind,
  source: HandbookRecordSource
): HandbookRecord {
  const { identifier, status, date } = source

  if (identifier === undefined || status === undefined || date === undefined) {
    throw new Error(
      `The ${kind} at "${source.href}" is missing required index metadata. ` +
        `A ${kind} requires an identifier, a status, and a date.`
    )
  }

  return {
    identifier,
    title: source.title,
    description: source.description,
    status,
    href: source.href,
    date,
    updated: source.updated,
    areas: source.areas ?? []
  }
}

/**
 * Fails the build when two records share one identifier.
 *
 * Identifiers are the stable cross-reference used by architecture pages, other
 * records, and external links, so a duplicate silently breaks references.
 *
 * @param kind - Record type being indexed, used in the failure message.
 * @param records - Index rows to check.
 * @throws When any identifier appears more than once.
 */
function assertUniqueIdentifiers(
  kind: RecordKind,
  records: readonly HandbookRecord[]
): void {
  const seenHrefs = new Map<string, string>()

  for (const record of records) {
    const previousHref = seenHrefs.get(record.identifier)

    if (previousHref !== undefined) {
      throw new Error(
        `Duplicate ${kind} identifier "${record.identifier}" is claimed by ` +
          `both "${previousHref}" and "${record.href}".`
      )
    }

    seenHrefs.set(record.identifier, record.href)
  }
}
