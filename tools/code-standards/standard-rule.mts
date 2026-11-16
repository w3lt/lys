import type { TSESLint } from "@typescript-eslint/utils"

/** Address of `docs/code_standards/` on the default branch, ending in a slash. */
const standardsDirectoryUrl =
  "https://github.com/w3lt/lys/blob/main/docs/code_standards/"

/** Rule options accepted by every plugin rule: none. */
const noRuleOptions = Object.freeze([])

/**
 * Heading in `docs/code_standards/` that owns the rule a plugin rule checks.
 *
 * @remarks The heading text is `<ruleId> — <title>`. The plugin's tests
 * confirm that every heading still exists, so a renamed heading fails them.
 */
export type StandardRuleHeading = {
  /** Stable identifier at the start of the heading. */
  readonly ruleId: string

  /** Chapter file name inside `docs/code_standards/`. */
  readonly chapterFile: string

  /** Heading text after the identifier and its em dash. */
  readonly title: string
}

/** Metadata that, with a listener factory, defines one plugin rule. */
export type StandardRuleMetadata<TMessageId extends string> = {
  /** Heading of the rule the plugin rule checks. */
  readonly heading: StandardRuleHeading

  /** One-sentence description of the part of the rule that is checked. */
  readonly description: string

  /** Report templates, each ending with the citation of the heading. */
  readonly messages: Readonly<Record<TMessageId, string>>
}

/** Listener factory that ESLint calls once per linted file. */
export type StandardRuleCreate<TMessageId extends string> = (
  context: Readonly<TSESLint.RuleContext<TMessageId, []>>
) => TSESLint.RuleListener

/**
 * Builds the anchor GitHub generates for a Markdown heading.
 *
 * @param headingText - Heading text without the leading `#` characters.
 * @returns The text in lowercase, with punctuation other than hyphens
 * removed and each space replaced by a hyphen.
 */
export function githubHeadingAnchor(headingText: string): string {
  return headingText
    .toLowerCase()
    .replaceAll(/[^a-z0-9 -]/g, "")
    .replaceAll(" ", "-")
}

/**
 * Builds the URL of a rule heading on the default branch.
 *
 * @param heading - Heading of the rule.
 * @returns The chapter URL with the heading's anchor.
 */
export function standardHeadingUrl(heading: StandardRuleHeading): string {
  const anchor = githubHeadingAnchor(`${heading.ruleId} — ${heading.title}`)
  return `${standardsDirectoryUrl}${heading.chapterFile}#${anchor}`
}

/**
 * Builds the citation that ends every report of a plugin rule.
 *
 * @param heading - Heading of the rule.
 * @returns The rule identifier followed by the URL of its heading.
 */
export function citeStandardRule(heading: StandardRuleHeading): string {
  return `${heading.ruleId}: ${standardHeadingUrl(heading)}`
}

/**
 * Builds an ESLint rule module for one checked part of a code-standard rule.
 *
 * @remarks ESLint imposes the module shape. The module accepts no options and
 * its `docs.url` links to the rule heading.
 * @param metadata - Heading, description, and report templates.
 * @param create - Listener factory that reports violations.
 * @returns A frozen rule module.
 */
export function createStandardRule<TMessageId extends string>(
  metadata: StandardRuleMetadata<TMessageId>,
  create: StandardRuleCreate<TMessageId>
): TSESLint.RuleModule<TMessageId, []> {
  const docs = Object.freeze({
    description: metadata.description,
    url: standardHeadingUrl(metadata.heading)
  })
  const meta = Object.freeze({
    type: "suggestion" as const,
    docs,
    messages: metadata.messages,
    schema: noRuleOptions
  })
  return Object.freeze({ meta, create })
}
