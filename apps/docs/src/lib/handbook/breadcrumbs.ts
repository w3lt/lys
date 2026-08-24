import { toSiteHref } from "./routing"

/**
 * Breadcrumb derivation for handbook article pages.
 *
 * The trail is derived from a page's content path rather than authored per
 * page, so it cannot drift away from where the page actually lives.
 */

/** One step of a breadcrumb trail. */
export type Breadcrumb = {
  /** Text shown for this step. */
  readonly label: string
  /**
   * Site-relative address of this step.
   *
   * Absent for the final step, which is the current page, and for a section
   * that has no index page of its own.
   */
  readonly href?: string
}

/** A top-level handbook section, as it appears in a breadcrumb trail. */
type HandbookSection = {
  /** Text shown for the section. */
  readonly label: string
  /**
   * Whether the section has an index page to link to.
   *
   * Linking a section without an index would emit a broken internal link, which
   * blocks the build by design.
   */
  readonly hasIndex: boolean
}

/**
 * The handbook's top-level sections.
 *
 * Only sections with published content appear here; the navigation grows as
 * content is authored rather than being scaffolded ahead of it.
 */
const HANDBOOK_SECTIONS: Readonly<Record<string, HandbookSection>> = {
  architecture: { label: "Architecture", hasIndex: false },
  decisions: { label: "Decisions", hasIndex: true },
  rfcs: { label: "RFCs", hasIndex: true },
  operate: { label: "Operate", hasIndex: false },
  reference: { label: "Reference", hasIndex: false }
}

/** Label of the trail's first step, which always addresses the handbook root. */
const ROOT_LABEL = "Handbook"

/**
 * Builds the breadcrumb trail for a handbook page.
 *
 * @param entryId - Content-entry identifier, such as
 * `decisions/adr-0007-credential-handles`. An empty identifier or `index` is
 * the homepage; `404` is the not-found page.
 * @param currentLabel - Text for the final step: a record's identifier where it
 * has one, otherwise the page title.
 * @returns The trail from the handbook root to the current page. The homepage
 * and the not-found page return an empty trail, because neither sits inside a
 * section a reader can navigate back through.
 */
export function toBreadcrumbTrail(
  entryId: string,
  currentLabel: string
): readonly Breadcrumb[] {
  if (entryId === "" || entryId === "index" || entryId === "404") {
    return []
  }

  const trail: Breadcrumb[] = [{ label: ROOT_LABEL, href: toSiteHref("") }]
  const segments = entryId.split("/")

  // The last segment is the page itself and is named by `currentLabel`.
  for (const [index, segment] of segments.slice(0, -1).entries()) {
    const section = HANDBOOK_SECTIONS[segment]
    const path = segments.slice(0, index + 1).join("/")

    if (section === undefined) {
      trail.push({ label: toReadableLabel(segment) })
      continue
    }

    trail.push({
      label: section.label,
      href: section.hasIndex ? toSiteHref(path) : undefined
    })
  }

  trail.push({ label: currentLabel })

  return trail
}

/**
 * Turns an unregistered path segment into readable text.
 *
 * Used for nested directories below a top-level section, such as `runbooks`,
 * which need a label but not their own registry entry.
 *
 * @param segment - A single path segment in kebab case.
 * @returns The segment with separators removed and its first letter capitalised.
 */
function toReadableLabel(segment: string): string {
  const spaced = segment.replaceAll("-", " ")

  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}
