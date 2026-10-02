import { readFile } from "node:fs/promises"
import type { DataStore, LoaderContext, ParseDataOptions } from "astro/loaders"

/**
 * Loading of the repository `CHANGELOG.md` into the `changelog` content
 * collection.
 *
 * `CHANGELOG.md` is the only authored copy of the release notes. Each released
 * version becomes one entry keyed by its version, and the handbook page for that
 * version renders the entry, so the file and the handbook show the same text.
 *
 * A section starts at a line beginning with `## ` and ends before the next such
 * line or at the end of the file. That holds inside fenced code too, so a code
 * line beginning with `## ` fails the load unless it is a release heading. Text
 * before the first section, such as the title and introduction, belongs to no
 * release, and the `## [Unreleased]` section is skipped. Each release is
 * rendered on its own, so a reference-style link resolves only when its
 * definition is in the same section.
 */

/** Line prefix of a level-2 ATX heading, which starts a new section. */
const SECTION_HEADING_PREFIX = "## "

/** Heading of the section that collects changes not released yet. */
const UNRELEASED_HEADING = "## [Unreleased]"

/**
 * Shape of a released version's heading: `## [<version>] - <release date>`.
 *
 * Only the shape is checked here. The `changelog` collection schema validates
 * the captured version and date.
 */
const RELEASE_HEADING = /^## \[(?<version>[^\]]+)\] - (?<released>\S+)$/

/** One level-2 section: its heading line and the Markdown below it. */
type ChangelogSection = {
  /** Heading line without trailing whitespace, such as `## [0.3.0] - 2026-10-02`. */
  readonly heading: string
  /** Markdown between the heading and the next section or the end of the file. */
  readonly body: string
}

/**
 * Release fields captured from a release heading.
 *
 * They are unvalidated until the collection schema parses them.
 */
type ChangelogReleaseData = {
  /** Version between the heading's brackets, such as `0.3.0`; also the entry id. */
  readonly version: string
  /** Release date after the heading's ` - ` separator, such as `2026-10-02`. */
  readonly released: string
}

/** One released version's section. */
type ChangelogRelease = {
  /** Fields captured from the release heading. */
  readonly data: ChangelogReleaseData
  /** Release notes below the heading, as Markdown. */
  readonly body: string
}

/** One `changelog` collection entry, ready for the store. */
type ChangelogEntry = {
  /** Release version, unique within the collection. */
  readonly id: string
  /** Release fields as returned by the collection schema. */
  readonly data: ChangelogReleaseData
  /** Release notes as Markdown. */
  readonly body: string
  /** Release notes rendered by the site's Markdown pipeline. */
  readonly rendered: Awaited<ReturnType<LoaderContext["renderMarkdown"]>>
}

/**
 * Loader capabilities that replacing the `changelog` collection uses: a narrow
 * view of Astro's loader context.
 */
type ChangelogLoaderContext = Pick<LoaderContext, "renderMarkdown"> & {
  /**
   * Validates one release with the `changelog` collection schema: Astro's
   * `parseData`, narrowed to release fields.
   */
  readonly parseData: (
    release: ParseDataOptions<ChangelogReleaseData>
  ) => Promise<ChangelogReleaseData>
  /** Store of the `changelog` collection, whose entries are replaced. */
  readonly store: Pick<DataStore, "clear" | "set">
}

/**
 * Replaces the `changelog` collection with the released versions in the
 * repository changelog.
 *
 * Each entry is keyed by its version and holds the release date, the release
 * notes as Markdown, and their rendered HTML. The store is cleared and refilled
 * only after every release has been parsed, validated, and rendered, so a
 * failure leaves the previous entries in place. In `astro dev`, a changed
 * `CHANGELOG.md` is read again only when the dev server restarts.
 *
 * @param changelogUrl - Location of `CHANGELOG.md`.
 * @param context - Loader capabilities of the `changelog` collection.
 * @returns A promise that resolves once the store holds exactly one entry per
 * released version, in file order.
 * @throws If the file cannot be read, a level-2 heading is neither
 * `## [Unreleased]` nor `## [<version>] - <date>`, two releases share a version,
 * the collection schema rejects a release, or rendering fails.
 */
export async function loadChangelogReleases(
  changelogUrl: URL,
  context: ChangelogLoaderContext
): Promise<void> {
  const changelog = await readFile(changelogUrl, "utf8")
  const releases = parseChangelogReleases(changelog)
  const entries = await Promise.all(
    releases.map((release) =>
      buildChangelogEntry(release, changelogUrl, context)
    )
  )

  context.store.clear()
  for (const entry of entries) {
    context.store.set(entry)
  }
}

/**
 * Parses the released versions out of the changelog, in file order.
 *
 * @param changelog - Complete `CHANGELOG.md` text.
 * @returns One release per release section; empty when the file has none.
 * @throws If a level-2 heading is neither `## [Unreleased]` nor a release
 * heading, or two releases share a version.
 */
function parseChangelogReleases(
  changelog: string
): readonly ChangelogRelease[] {
  const releases = listChangelogSections(changelog)
    .filter((section) => section.heading !== UNRELEASED_HEADING)
    .map(parseChangelogRelease)
  const versions = releases.map((release) => release.data.version)
  const duplicateVersion = versions.find(
    (version, index) => versions.indexOf(version) !== index
  )

  if (duplicateVersion !== undefined) {
    throw new Error(
      `CHANGELOG.md has more than one section for version ${duplicateVersion}.`
    )
  }

  return releases
}

/**
 * Lists the level-2 sections of the changelog, in file order.
 *
 * @param changelog - Complete `CHANGELOG.md` text, with LF or CRLF line endings.
 * @returns The sections; empty when no line begins with `## `.
 */
function listChangelogSections(changelog: string): readonly ChangelogSection[] {
  const lines = changelog.split(/\r?\n/)
  const headingIndexes = lines.flatMap((line, index) =>
    line.startsWith(SECTION_HEADING_PREFIX) ? [index] : []
  )

  return headingIndexes.map((headingIndex, position) => ({
    heading: lines[headingIndex].trimEnd(),
    body: lines.slice(headingIndex + 1, headingIndexes[position + 1]).join("\n")
  }))
}

/**
 * Parses one section that is not `## [Unreleased]` as a release.
 *
 * @param section - Level-2 section of the changelog.
 * @returns The fields captured from the heading, with the section body.
 * @throws If the heading does not have the `## [<version>] - <date>` shape.
 */
function parseChangelogRelease(section: ChangelogSection): ChangelogRelease {
  const releaseFields = RELEASE_HEADING.exec(section.heading)?.groups

  if (releaseFields === undefined) {
    throw new Error(
      `CHANGELOG.md heading "${section.heading}" is neither "${UNRELEASED_HEADING}" nor "## [<version>] - <YYYY-MM-DD>".`
    )
  }

  return {
    data: { version: releaseFields.version, released: releaseFields.released },
    body: section.body
  }
}

/**
 * Validates and renders one release as a collection entry.
 *
 * @param release - Release parsed from the changelog.
 * @param changelogUrl - Location of `CHANGELOG.md`, against which rendering
 * resolves relative references.
 * @param context - Validation and rendering capabilities of the loader.
 * @returns The entry keyed by the release version.
 * @throws If the collection schema rejects the release or rendering fails.
 */
async function buildChangelogEntry(
  release: ChangelogRelease,
  changelogUrl: URL,
  context: ChangelogLoaderContext
): Promise<ChangelogEntry> {
  const data = await context.parseData({
    id: release.data.version,
    data: release.data
  })
  const rendered = await context.renderMarkdown(release.body, {
    fileURL: changelogUrl
  })

  return { id: release.data.version, data, body: release.body, rendered }
}
