/**
 * Status vocabulary shared by handbook decisions, proposals, and their
 * generated indexes.
 *
 * Status is presented with an icon and a label in addition to colour, so a
 * reader who cannot distinguish the status hues still reads the same state.
 */

/** Status an Architecture Decision Record may carry. */
export type DecisionStatus = "accepted" | "superseded" | "deprecated"

/**
 * Proposal statuses in the order a proposal moves through them.
 *
 * Filters and legends read this rather than the order records happen to be
 * loaded in, so the same set of statuses always reads as the same sequence.
 */
export const PROPOSAL_STATUS_ORDER = [
  "draft",
  "discussion",
  "accepted",
  "implemented",
  "rejected",
  "withdrawn"
] as const

/** Status a Request for Comments may carry. */
export type ProposalStatus = (typeof PROPOSAL_STATUS_ORDER)[number]

/** Any status a handbook record may carry. */
export type DocumentStatus = DecisionStatus | ProposalStatus

/**
 * Semantic colour role a status maps onto.
 *
 * Tones name the meaning of a state rather than a hue, so the palette can
 * change without rewriting the status vocabulary.
 */
export type StatusTone = "success" | "pending" | "danger" | "neutral"

/** How one status is rendered wherever it appears. */
export type StatusPresentation = {
  /** Colour role the status pill uses. */
  readonly tone: StatusTone
  /** Glyph carrying the state without relying on colour. */
  readonly icon: string
  /** Lower-case label shown beside the glyph. */
  readonly label: string
}

/**
 * The single presentation table for every handbook status.
 *
 * Indexes, badges, and notices all read from this record so one status cannot
 * acquire two different appearances in two places.
 */
export const DOCUMENT_STATUS_PRESENTATION: Readonly<
  Record<DocumentStatus, StatusPresentation>
> = {
  accepted: { tone: "success", icon: "✓", label: "accepted" },
  implemented: { tone: "success", icon: "✔", label: "implemented" },
  draft: { tone: "neutral", icon: "○", label: "draft" },
  discussion: { tone: "pending", icon: "◑", label: "discussion" },
  /*
   * A superseded record is not a warning: the decision it replaced is recorded
   * and current work is unaffected, so it is retired rather than flagged.
   */
  superseded: { tone: "neutral", icon: "↻", label: "superseded" },
  /*
   * A deprecated record still guides nothing, but it has no replacement to
   * follow, so it carries the same caution as any unresolved state.
   */
  deprecated: { tone: "pending", icon: "⚠", label: "deprecated" },
  rejected: { tone: "danger", icon: "✕", label: "rejected" },
  withdrawn: { tone: "neutral", icon: "⊘", label: "withdrawn" }
}

/** Which register a record belongs to. */
export type RecordKind = "decision" | "proposal"

/** The standing notice shown at the top of a record in a given status. */
export type DocumentNotice = {
  /** Heading of the notice. */
  readonly title: string
  /**
   * Colour role the notice uses, when it differs from the status's own.
   *
   * A status pill reports where a record stands; a notice warns a reader who
   * may be about to act on the wrong document. The two can disagree: a
   * superseded decision is retired rather than alarming, but opening one by
   * mistake still needs to be caught.
   *
   * Omit to take the status's registered tone.
   */
  readonly tone?: StatusTone
  /**
   * Glyph shown beside the notice, when it differs from the status's own.
   *
   * Omit to take the status's registered icon.
   */
  readonly icon?: string
  /**
   * Standing explanation of what the status means for a reader.
   *
   * Always true for the status, so it is owned here rather than repeated in
   * every record's frontmatter. A record may add its own specific reason in
   * front of it.
   */
  readonly body: string
}

/**
 * Notices by register and status.
 *
 * A status alone is not enough to choose a notice: an accepted decision is
 * current and needs none, while an accepted proposal describes a future change
 * and must say so. A status absent from a register's table needs no notice.
 */
const DOCUMENT_NOTICES: Readonly<
  Record<RecordKind, Readonly<Partial<Record<DocumentStatus, DocumentNotice>>>>
> = {
  decision: {
    superseded: {
      title: "Historical document",
      tone: "pending",
      icon: "⚠",
      body: "The reasoning below is preserved as evidence and is not corrected to match current behaviour."
    },
    deprecated: {
      title: "Deprecated decision",
      tone: "pending",
      icon: "⚠",
      body: "This decision is no longer in force. It is preserved as evidence and is not corrected to match current behaviour."
    }
  },
  proposal: {
    draft: {
      title: "Draft proposal",
      body: "This proposal is incomplete and may change substantially. It does not describe current architecture."
    },
    discussion: {
      title: "Under discussion",
      body: "This proposal is under review and has not been approved. It does not describe current architecture."
    },
    accepted: {
      title: "Approved future change",
      body: "This proposal is approved but not yet implemented, so it does not describe current architecture."
    },
    implemented: {
      title: "Implemented",
      body: "This proposal has shipped. Current architecture and reference pages describe the behaviour; this document is kept for its reasoning."
    },
    rejected: {
      title: "Rejected proposal",
      body: "This proposal was not adopted. It is preserved so the reasoning against it stays available."
    },
    withdrawn: {
      title: "Withdrawn proposal",
      body: "This proposal was withdrawn before a decision was reached. It is preserved as a record of the attempt."
    }
  }
}

/**
 * Resolves the notice a record in this status must carry.
 *
 * @param kind - Register the record belongs to.
 * @param status - Status the record carries.
 * @returns The notice, or `undefined` when the status is current for its
 * register and needs no notice.
 */
export function resolveDocumentNotice(
  kind: RecordKind,
  status: DocumentStatus
): DocumentNotice | undefined {
  return DOCUMENT_NOTICES[kind][status]
}

/**
 * Resolves the presentation for a status.
 *
 * @param status - Status carried by the document.
 * @returns The one presentation registered for that status.
 * @throws When the status has no registered presentation, which means the
 * vocabulary and this table have drifted apart.
 */
export function resolveStatusPresentation(
  status: DocumentStatus
): StatusPresentation {
  const presentation = DOCUMENT_STATUS_PRESENTATION[status]

  if (presentation === undefined) {
    throw new Error(
      `Status "${status}" has no registered presentation. Add it to DOCUMENT_STATUS_PRESENTATION.`
    )
  }

  return presentation
}
