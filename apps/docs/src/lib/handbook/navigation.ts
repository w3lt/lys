import type { StarlightRouteData } from "@astrojs/starlight/route-data"

/**
 * Queries over the navigation tree Starlight publishes on its route data.
 *
 * The rail renders that tree itself so it can carry the design's section icons,
 * so it also needs the open-state question Starlight's own sidebar answers
 * internally: does this group hold the page being read?
 */

/** One entry of the navigation tree: a link, or a group of further entries. */
export type NavigationEntry = StarlightRouteData["sidebar"][number]

/**
 * Reports whether an entry addresses the page currently being read.
 *
 * A group reports its descendants at any depth, so a group holding the current
 * page opens even when the page sits inside a nested group.
 *
 * @param entry - Entry to test, taken from `Astro.locals.starlightRoute`.
 * @returns `true` when the entry is the current page, or contains it.
 */
export function containsCurrentPage(entry: NavigationEntry): boolean {
  if (entry.type === "link") {
    return entry.isCurrent
  }

  return entry.entries.some(containsCurrentPage)
}
