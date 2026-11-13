import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"
import { codeStandardsPlugin, codeStandardsPluginName } from "../plugin.mts"
import { githubHeadingAnchor } from "../standard-rule.mts"

/** Absolute path of the repository root. */
const repositoryRoot = join(import.meta.dirname, "..", "..", "..")

/** Directory of the item standards. */
const standardsDirectory = join(repositoryRoot, "docs", "code_standards")

/** Handbook page that classifies every rule identifier. */
const inventoryPage = readFileSync(
  join(repositoryRoot, "apps/docs/src/content/docs/reference/rule-checks.mdx"),
  "utf8"
)

/** Text of every item standard by chapter file name. */
const chapters: ReadonlyMap<string, string> = new Map(
  readdirSync(standardsDirectory)
    .filter((file) => file.endsWith(".md"))
    .map((file) => [file, readFileSync(join(standardsDirectory, file), "utf8")])
)

/**
 * Reads the text of one second-level section of the inventory page.
 *
 * @param title - Section heading without `## `.
 * @returns The text up to the next second-level heading.
 */
function inventorySection(title: string): string {
  const [, afterHeading = ""] = inventoryPage.split(`\n## ${title}\n`)
  return afterHeading.split("\n## ")[0] ?? ""
}

/**
 * Lists the identifiers a table section classifies, one per row.
 *
 * @param title - Section heading without `## `.
 * @returns The identifier in the first cell of each table row.
 */
function tableIdentifiers(title: string): string[] {
  const rows = inventorySection(title).matchAll(/^\| `([A-Z]+-\d{3})`/gm)
  return [...rows].map((row) => row[1] ?? "")
}

describe("rule check inventory", () => {
  it("classifies every rule identifier of the item standards exactly once", () => {
    const standardIdentifiers = [...chapters.values()].flatMap((text) =>
      [...text.matchAll(/^### ([A-Z]+-\d{3}) /gm)].map((match) => match[1])
    )
    const reviewOnlyIdentifiers = [
      ...inventorySection("Review-only rules").matchAll(/`([A-Z]+-\d{3})`/g)
    ].map((match) => match[1])
    const classifiedIdentifiers = [
      ...tableIdentifiers("Exact rules"),
      ...tableIdentifiers("Advisory rules"),
      ...reviewOnlyIdentifiers
    ]

    assert.deepEqual(
      classifiedIdentifiers.toSorted(),
      standardIdentifiers.toSorted()
    )
  })

  it("names every plugin rule as the check of an exact rule", () => {
    const exactSection = inventorySection("Exact rules")
    const missingRules = Object.keys(codeStandardsPlugin.rules)
      .map((name) => `\`${codeStandardsPluginName}/${name}\``)
      .filter((ruleName) => !exactSection.includes(ruleName))

    assert.deepEqual(missingRules, [])
  })

  it("links every plugin rule to an existing rule heading", () => {
    const headingUrls = [...chapters].flatMap(([file, text]) =>
      [...text.matchAll(/^### (.+)$/gm)].map(
        (match) => `${file}#${githubHeadingAnchor(match[1] ?? "")}`
      )
    )
    const brokenUrls = Object.values(codeStandardsPlugin.rules)
      .map((rule) => rule.meta.docs?.url ?? "")
      .filter(
        (url) => !headingUrls.some((target) => url.endsWith(`/${target}`))
      )

    assert.deepEqual(brokenUrls, [])
  })
})
