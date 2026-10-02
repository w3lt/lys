import { defineCollection } from "astro:content"
import { z } from "astro/zod"
import { docsLoader, i18nLoader } from "@astrojs/starlight/loaders"
import { docsSchema, i18nSchema } from "@astrojs/starlight/schema"
import { loadChangelogReleases } from "./lib/handbook/changelog"

/**
 * Calendar dates are authored as `YYYY-MM-DD` strings rather than parsed dates
 * so that a decision date is a stable published fact, independent of the build
 * machine's time zone.
 */
const ISO_CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/

/** Stable handbook record identifier, such as `ADR-0007` or `RFC-0004`. */
const RECORD_IDENTIFIER = /^(ADR|RFC)-\d{4}$/

/**
 * Statuses an Architecture Decision Record may carry.
 *
 * An ADR is historical evidence: a materially changed decision receives a new
 * ADR that supersedes the previous one rather than an edit to the original.
 */
const decisionStatus = z.enum(["accepted", "superseded", "deprecated"])

/**
 * Statuses a Request for Comments may carry.
 *
 * `accepted` describes an approved future change; it does not describe current
 * architecture until the implementation lands and the RFC becomes
 * `implemented`.
 */
const proposalStatus = z.enum([
  "draft",
  "discussion",
  "accepted",
  "implemented",
  "rejected",
  "withdrawn"
])

/**
 * The form of knowledge a handbook page carries.
 *
 * The value selects which metadata the page must supply and how the page is
 * presented, so it is validated rather than inferred from a directory name.
 */
const documentType = z.enum([
  "architecture",
  "decision",
  "proposal",
  "runbook",
  "reference"
])

/** One recorded transition in a proposal's status history. */
const statusHistoryEntry = z.object({
  /** Calendar date the transition was recorded, as `YYYY-MM-DD`. */
  date: z.string().regex(ISO_CALENDAR_DATE),
  /** Status the proposal moved to on that date. */
  status: proposalStatus,
  /** Why the transition happened, in one sentence. */
  note: z.string().min(1)
})

/**
 * Metadata shared by every handbook page, on top of Starlight's own schema.
 *
 * Fields stay minimal on purpose: git history and Starlight's last-updated
 * information are preferred over hand-maintained freshness fields that drift
 * into being false. Related-document links are authored inline beside the prose
 * they belong to, through the `RelatedDocuments` component's own contract,
 * rather than duplicated into frontmatter.
 */
const handbookFrontmatter = z.object({
  docType: documentType.optional(),
  identifier: z.string().regex(RECORD_IDENTIFIER).optional(),
  status: z.union([decisionStatus, proposalStatus]).optional(),
  /** Date a decision was accepted, as `YYYY-MM-DD`. Decisions only. */
  decided: z.string().regex(ISO_CALENDAR_DATE).optional(),
  /** Proposal author. Proposals only. */
  author: z.string().min(1).optional(),
  /** Date a proposal was opened, as `YYYY-MM-DD`. Proposals only. */
  created: z.string().regex(ISO_CALENDAR_DATE).optional(),
  /** Date a proposal last changed substantively, as `YYYY-MM-DD`. */
  updated: z.string().regex(ISO_CALENDAR_DATE).optional(),
  /** Subsystems the document affects. */
  areas: z.array(z.string().min(1)).nonempty().optional(),
  /** Identifier of the record this document replaces. */
  supersedes: z.string().regex(RECORD_IDENTIFIER).optional(),
  /** Identifier of the record that replaced this document. */
  supersededBy: z.string().regex(RECORD_IDENTIFIER).optional(),
  /** Why this document is no longer current, shown in its status notice. */
  statusNotice: z.string().min(1).optional(),
  /** Owning application or package of a documented contract. Reference only. */
  contract: z.string().min(1).optional(),
  /** Contract version of a reference page, such as `v1`. */
  contractVersion: z.string().min(1).optional(),
  /**
   * How much a documented contract may still change. Reference only.
   *
   * A reader has to know whether a documented field is safe to depend on, so a
   * reference page states its stability rather than leaving it to be inferred.
   */
  stability: z.enum(["stable", "experimental", "deprecated"]).optional(),
  statusHistory: z.array(statusHistoryEntry).nonempty().optional()
})

/**
 * Handbook frontmatter with the per-type requirements of the approved content
 * model enforced.
 *
 * The pipeline fails closed: a decision or proposal missing its identifying
 * metadata blocks the build rather than rendering an index row with holes in
 * it.
 */
const validatedHandbookFrontmatter = handbookFrontmatter.superRefine(
  (frontmatter, context) => {
    const requireField = (
      field: keyof typeof frontmatter,
      docTypeLabel: string
    ): void => {
      if (frontmatter[field] === undefined) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `A ${docTypeLabel} requires "${field}".`
        })
      }
    }

    if (frontmatter.docType === "decision") {
      requireField("identifier", "decision")
      requireField("status", "decision")
      requireField("decided", "decision")
      requireField("areas", "decision")

      const allowedStatuses: readonly string[] = decisionStatus.options

      if (
        frontmatter.status !== undefined &&
        !allowedStatuses.includes(frontmatter.status)
      ) {
        context.addIssue({
          code: "custom",
          path: ["status"],
          message: `A decision status must be one of ${allowedStatuses.join(", ")}.`
        })
      }
    }

    if (frontmatter.docType === "proposal") {
      requireField("identifier", "proposal")
      requireField("status", "proposal")
      requireField("author", "proposal")
      requireField("created", "proposal")
      requireField("areas", "proposal")
    }
  }
)

/**
 * Location of the repository `CHANGELOG.md`, relative to the docs app root that
 * Astro reports as `config.root`.
 */
const CHANGELOG_PATH_FROM_DOCS_ROOT = "../../CHANGELOG.md"

export const collections = {
  docs: defineCollection({
    loader: docsLoader(),
    schema: docsSchema({ extend: validatedHandbookFrontmatter })
  }),
  /**
   * Released versions in `CHANGELOG.md`, one entry per version, keyed by that
   * version.
   *
   * Handbook release pages render these entries, so the release notes are
   * authored only in `CHANGELOG.md`.
   */
  changelog: defineCollection({
    loader: {
      name: "lys-changelog",
      load: (context) =>
        loadChangelogReleases(
          new URL(CHANGELOG_PATH_FROM_DOCS_ROOT, context.config.root),
          context
        )
    },
    schema: z.object({
      /** Release version, such as `0.3.0`. */
      version: z.string().min(1),
      /** Release date, as `YYYY-MM-DD`. */
      released: z.string().regex(ISO_CALENDAR_DATE)
    })
  }),
  /**
   * Overrides for Starlight's own interface strings.
   *
   * Only the strings the handbook design words differently are listed; every
   * other string keeps Starlight's translation.
   */
  i18n: defineCollection({ loader: i18nLoader(), schema: i18nSchema() })
}
