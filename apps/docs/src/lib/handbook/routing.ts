/**
 * Address resolution for generated handbook indexes and breadcrumbs.
 *
 * Starlight owns routing for authored pages. Generated navigation links to
 * those pages by path, so it needs the same mapping without importing a page's
 * own route context.
 */

/**
 * Resolves a site-relative address for a handbook path.
 *
 * The site's configured base path is honoured, so generated links keep working
 * when the handbook is published under a subdirectory such as a project Pages
 * site.
 *
 * @param path - Handbook path without surrounding slashes, such as
 * `decisions/adr-0007-credential-handles`. Pass an empty string for the
 * handbook root.
 * @returns The site-relative address, with leading and trailing slashes.
 */
export function toSiteHref(path: string): string {
  const base = import.meta.env.BASE_URL
  const normalizedBase = base.endsWith("/") ? base : `${base}/`

  return path === "" ? normalizedBase : `${normalizedBase}${path}/`
}
