import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it, onTestFinished, vi } from "vitest"
import {
  loadChangelogReleases,
  type ChangelogLoaderContext
} from "../../../../src/lib/handbook/changelog"

/**
 * Changelog with a title, an introduction, an Unreleased section, and two
 * releases, newest first, as the repository file is written.
 */
const RELEASED_CHANGELOG = [
  "# Changelog",
  "",
  "Introduction that belongs to no release.",
  "",
  "## [Unreleased]",
  "",
  "- Not released yet.",
  "",
  "## [0.4.0] - 2026-11-01",
  "",
  "### Added",
  "",
  "- Second release.",
  "",
  "## [0.3.0] - 2026-10-02",
  "",
  "### Fixed",
  "",
  "- First release.",
  ""
].join("\n")

/**
 * Writes `CHANGELOG.md` into a temporary directory owned by the current test.
 *
 * @param changelog - Complete file contents.
 * @returns Location of the written file. The directory is removed when the test
 * finishes.
 */
async function saveOwnedChangelog(changelog: string): Promise<URL> {
  const directory = await mkdtemp(join(tmpdir(), "lys-changelog-test-"))
  onTestFinished(async () => {
    await rm(directory, { recursive: true, force: true })
  })
  const changelogPath = join(directory, "CHANGELOG.md")
  await writeFile(changelogPath, changelog, "utf8")
  return pathToFileURL(changelogPath)
}

/**
 * Creates loader capabilities whose calls the test observes.
 *
 * @returns Capabilities that accept every release unchanged, render Markdown
 * as `<rendered>` around the source text, and record every store call.
 */
function createObservedLoaderContext() {
  return {
    parseData: vi.fn<ChangelogLoaderContext["parseData"]>(
      async ({ data }) => data
    ),
    renderMarkdown: vi.fn<ChangelogLoaderContext["renderMarkdown"]>(
      async (markdown) => ({ html: `<rendered>${markdown}</rendered>` })
    ),
    store: {
      clear: vi.fn<ChangelogLoaderContext["store"]["clear"]>(),
      set: vi.fn<ChangelogLoaderContext["store"]["set"]>(() => true)
    }
  } satisfies ChangelogLoaderContext
}

/**
 * Lists the entries written to the observed store, in write order.
 *
 * @param context - Capabilities passed to the loader.
 * @returns Each entry passed to `store.set`.
 */
function listStoredEntries(
  context: ReturnType<typeof createObservedLoaderContext>
): readonly unknown[] {
  return context.store.set.mock.calls.map(([entry]) => entry)
}

describe("loadChangelogReleases", () => {
  it("stores one entry per released version, in file order, keyed by version", async () => {
    const changelogUrl = await saveOwnedChangelog(RELEASED_CHANGELOG)
    const context = createObservedLoaderContext()

    await loadChangelogReleases(changelogUrl, context)

    expect(listStoredEntries(context)).toEqual([
      {
        id: "0.4.0",
        data: { version: "0.4.0", released: "2026-11-01" },
        body: "\n### Added\n\n- Second release.\n",
        rendered: {
          html: "<rendered>\n### Added\n\n- Second release.\n</rendered>"
        }
      },
      {
        id: "0.3.0",
        data: { version: "0.3.0", released: "2026-10-02" },
        body: "\n### Fixed\n\n- First release.\n",
        rendered: {
          html: "<rendered>\n### Fixed\n\n- First release.\n</rendered>"
        }
      }
    ])
  })

  it("validates each release with the collection schema and renders it against the changelog location", async () => {
    const changelogUrl = await saveOwnedChangelog(RELEASED_CHANGELOG)
    const context = createObservedLoaderContext()

    await loadChangelogReleases(changelogUrl, context)

    expect(context.parseData.mock.calls).toEqual([
      [{ id: "0.4.0", data: { version: "0.4.0", released: "2026-11-01" } }],
      [{ id: "0.3.0", data: { version: "0.3.0", released: "2026-10-02" } }]
    ])
    expect(context.renderMarkdown.mock.calls).toEqual([
      ["\n### Added\n\n- Second release.\n", { fileURL: changelogUrl }],
      ["\n### Fixed\n\n- First release.\n", { fileURL: changelogUrl }]
    ])
  })

  it("clears the previous entries once, before writing the first new entry", async () => {
    const changelogUrl = await saveOwnedChangelog(RELEASED_CHANGELOG)
    const context = createObservedLoaderContext()

    await loadChangelogReleases(changelogUrl, context)

    expect(context.store.clear).toHaveBeenCalledOnce()
    expect(context.store.clear.mock.invocationCallOrder[0]).toBeLessThan(
      context.store.set.mock.invocationCallOrder[0]
    )
  })

  it("reads a CRLF file as the same sections, with LF bodies", async () => {
    const changelogUrl = await saveOwnedChangelog(
      "# Changelog\r\n\r\n## [0.3.0] - 2026-10-02\r\n\r\n- First release.\r\n"
    )
    const context = createObservedLoaderContext()

    await loadChangelogReleases(changelogUrl, context)

    expect(listStoredEntries(context)).toEqual([
      expect.objectContaining({
        id: "0.3.0",
        data: { version: "0.3.0", released: "2026-10-02" },
        body: "\n- First release.\n"
      })
    ])
  })

  it("clears the store and writes nothing when no version has been released", async () => {
    const changelogUrl = await saveOwnedChangelog(
      "# Changelog\n\n## [Unreleased]\n\n- Not released yet.\n"
    )
    const context = createObservedLoaderContext()

    await loadChangelogReleases(changelogUrl, context)

    expect(context.store.clear).toHaveBeenCalledOnce()
    expect(context.store.set).not.toHaveBeenCalled()
  })

  it.each([
    ["a heading without brackets", "## Notes"],
    ["a release heading without a date", "## [0.3.0]"],
    ["a differently cased Unreleased heading", "## [unreleased]"]
  ])("rejects %s and leaves the store unchanged", async (_label, heading) => {
    const changelogUrl = await saveOwnedChangelog(
      `# Changelog\n\n${heading}\n\n- Entry.\n`
    )
    const context = createObservedLoaderContext()

    await expect(loadChangelogReleases(changelogUrl, context)).rejects.toThrow(
      heading
    )
    expect(context.store.clear).not.toHaveBeenCalled()
    expect(context.store.set).not.toHaveBeenCalled()
  })

  it("rejects a fenced code line that begins with a level-2 heading prefix", async () => {
    const changelogUrl = await saveOwnedChangelog(
      "## [0.3.0] - 2026-10-02\n\n```md\n## Not a heading\n```\n"
    )
    const context = createObservedLoaderContext()

    await expect(loadChangelogReleases(changelogUrl, context)).rejects.toThrow(
      "## Not a heading"
    )
    expect(context.store.set).not.toHaveBeenCalled()
  })

  it("rejects two sections for the same version and leaves the store unchanged", async () => {
    const changelogUrl = await saveOwnedChangelog(
      "## [0.3.0] - 2026-10-02\n\n- One.\n\n## [0.3.0] - 2026-10-03\n\n- Two.\n"
    )
    const context = createObservedLoaderContext()

    await expect(loadChangelogReleases(changelogUrl, context)).rejects.toThrow(
      "0.3.0"
    )
    expect(context.store.clear).not.toHaveBeenCalled()
    expect(context.store.set).not.toHaveBeenCalled()
  })

  it("propagates a collection schema rejection and leaves the store unchanged", async () => {
    const changelogUrl = await saveOwnedChangelog(RELEASED_CHANGELOG)
    const context = createObservedLoaderContext()
    const schemaRejection = new Error("released: invalid date")
    context.parseData.mockRejectedValueOnce(schemaRejection)

    await expect(loadChangelogReleases(changelogUrl, context)).rejects.toBe(
      schemaRejection
    )
    expect(context.store.clear).not.toHaveBeenCalled()
    expect(context.store.set).not.toHaveBeenCalled()
  })

  it("propagates a rendering failure and leaves the store unchanged", async () => {
    const changelogUrl = await saveOwnedChangelog(RELEASED_CHANGELOG)
    const context = createObservedLoaderContext()
    const renderingFailure = new Error("Markdown pipeline failed")
    context.renderMarkdown.mockRejectedValueOnce(renderingFailure)

    await expect(loadChangelogReleases(changelogUrl, context)).rejects.toBe(
      renderingFailure
    )
    expect(context.store.clear).not.toHaveBeenCalled()
    expect(context.store.set).not.toHaveBeenCalled()
  })

  it("rejects with the read failure when CHANGELOG.md does not exist", async () => {
    const changelogUrl = await saveOwnedChangelog(RELEASED_CHANGELOG)
    const missingChangelogUrl = new URL("MISSING.md", changelogUrl)
    const context = createObservedLoaderContext()

    await expect(
      loadChangelogReleases(missingChangelogUrl, context)
    ).rejects.toMatchObject({ code: "ENOENT" })
    expect(context.store.clear).not.toHaveBeenCalled()
    expect(context.store.set).not.toHaveBeenCalled()
  })
})
