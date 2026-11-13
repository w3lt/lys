import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { ESLint, type Linter } from "eslint"
import {
  overlapsChange,
  parseUnifiedDiff,
  wholeFileRange,
  type ChangedFile
} from "./changed-lines.mts"
import { codeStandardsPluginName } from "./plugin.mts"

/**
 * Change whose code is checked: the staged changes against `HEAD`, or the
 * working tree, untracked files included, against the merge base of a ref.
 */
type ChangeSource =
  | { readonly kind: "staged" }
  | { readonly kind: "base"; readonly baseRef: string }

/** Repository whose change is checked. */
type Checkout = {
  /** Absolute path of the working tree's top-level directory. */
  readonly root: string

  /** Change to check. */
  readonly source: ChangeSource
}

/** Plugin report, or parse failure, inside a changed construct. */
type Violation = {
  /** Repository-relative path of the file. */
  readonly path: string

  /** ESLint's message. */
  readonly message: Linter.LintMessage
}

/** Usage printed when the arguments name no single change source. */
const usage =
  "Usage: node tools/code-standards/check-changed-code.mts (--staged | --base <ref>)"

/** Options for the git commands whose diffs `parseUnifiedDiff` reads. */
const diffOptions = Object.freeze([
  "-c",
  "core.quotePath=false",
  "diff",
  "-U0",
  "--no-color",
  "--no-ext-diff",
  "-M",
  "--diff-filter=d"
])

/**
 * Absolute path of git. An absolute path keeps a writable directory in the
 * caller's `PATH` from standing in for git. macOS with the Command Line Tools,
 * which the repository's setup requires, and the Linux CI runners install git
 * there.
 */
const gitExecutable = "/usr/bin/git"

/**
 * Accepted `--base` value: a branch, tag, remote-tracking ref, commit, or
 * revision expression such as `HEAD~1`. It cannot start with `-`, so git can
 * never read it as an option.
 */
const baseRefPattern = /^\w[\w./@^~-]*$/

/** Largest git output read, in bytes. */
const gitOutputLimit = 256 * 1024 * 1024

/**
 * Runs git in the repository and returns its standard output.
 *
 * @param root - Directory git runs in.
 * @param args - Arguments after `git`.
 * @returns Standard output.
 * @throws If git cannot run or exits with a failure status.
 */
function runGit(root: string, args: readonly string[]): string {
  return execFileSync(gitExecutable, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: gitOutputLimit
  })
}

/**
 * Reads the change source from the command-line arguments.
 *
 * @param args - Arguments after the script path.
 * @returns The change source.
 * @throws If the arguments name no source, both sources, unknown options, or
 * a base that is not a ref or commit.
 */
function parseChangeSource(args: readonly string[]): ChangeSource {
  const staged = Object.freeze({ type: "boolean" as const })
  const base = Object.freeze({ type: "string" as const })
  const options = Object.freeze({ staged, base })
  const { values } = parseArgs({ args: [...args], options })
  if (values.staged === (values.base !== undefined)) {
    throw new Error(usage)
  }
  if (values.base !== undefined && !baseRefPattern.test(values.base)) {
    throw new Error(`--base must name a ref or commit: ${values.base}`)
  }
  return values.base === undefined
    ? Object.freeze({ kind: "staged" })
    : Object.freeze({ kind: "base", baseRef: values.base })
}

/**
 * Lists the files a change added or modified, with their changed lines.
 *
 * @param checkout - Repository and change to inspect.
 * @returns Changed files; an untracked file counts as changed in full.
 * @throws If a git command fails.
 */
function listChangedFiles(checkout: Checkout): ChangedFile[] {
  const { root, source } = checkout
  if (source.kind === "staged") {
    return parseUnifiedDiff(runGit(root, [...diffOptions, "--cached"]))
  }
  const mergeBase = runGit(root, [
    "merge-base",
    "--end-of-options",
    source.baseRef,
    "HEAD"
  ]).trim()
  const untrackedPaths = runGit(root, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z"
  ])
    .split("\0")
    .filter((path) => path !== "")
  const untrackedFiles = untrackedPaths.map((path) =>
    Object.freeze({ path, ranges: Object.freeze([wholeFileRange]) })
  )
  return [
    ...parseUnifiedDiff(runGit(root, [...diffOptions, mergeBase])),
    ...untrackedFiles
  ]
}

/**
 * Reads the new version of a changed file.
 *
 * @param checkout - Repository and change the file belongs to.
 * @param path - Repository-relative path.
 * @returns The staged content, or the working-tree content.
 * @throws If the content cannot be read.
 */
function readNewVersion(checkout: Checkout, path: string): string {
  if (checkout.source.kind === "staged") {
    return runGit(checkout.root, ["show", `:${path}`])
  }
  return readFileSync(join(checkout.root, path), "utf8")
}

/**
 * Lints one changed file and keeps the reports inside changed constructs.
 *
 * @param eslint - ESLint instance limited to the plugin's rules.
 * @param checkout - Repository and change the file belongs to.
 * @param file - Changed file and its changed lines.
 * @returns Plugin reports whose construct overlaps a changed line, and any
 * parse failure, which leaves the file unchecked.
 */
async function lintChangedFile(
  eslint: ESLint,
  checkout: Checkout,
  file: ChangedFile
): Promise<Violation[]> {
  const filePath = join(checkout.root, file.path)
  if (file.ranges.length === 0 || (await eslint.isPathIgnored(filePath))) {
    return []
  }
  const text = readNewVersion(checkout, file.path)
  const results = await eslint.lintText(text, { filePath, warnIgnored: false })
  return results
    .flatMap((result) => result.messages)
    .filter(
      (message) =>
        message.fatal === true ||
        overlapsChange(
          message.line,
          message.endLine ?? message.line,
          file.ranges
        )
    )
    .map((message) => Object.freeze({ path: file.path, message }))
}

/**
 * Formats one violation as `path:line:column message (rule)`.
 *
 * @param violation - Violation to format.
 * @returns One line of output.
 */
function formatViolation(violation: Violation): string {
  const { path, message } = violation
  const rule = message.ruleId ?? "parse error"
  return `${path}:${message.line}:${message.column} ${message.message} (${rule})`
}

/**
 * Checks a change and prints every plugin report inside a changed construct.
 *
 * @param checkout - Repository and change to check.
 * @returns Whether the change has no violation.
 * @throws If git fails or ESLint cannot load its configuration.
 */
async function checkChange(checkout: Checkout): Promise<boolean> {
  const rulePrefix = `${codeStandardsPluginName}/`
  const eslint = new ESLint({
    cwd: checkout.root,
    ruleFilter: ({ ruleId }) => ruleId.startsWith(rulePrefix)
  })
  const violationsByFile = await Promise.all(
    listChangedFiles(checkout).map((file) =>
      lintChangedFile(eslint, checkout, file)
    )
  )
  const violations = violationsByFile.flat()
  for (const violation of violations) {
    console.error(formatViolation(violation))
  }
  const count = violations.length
  const noun = count === 1 ? "violation" : "violations"
  console.log(
    count === 0
      ? "No code-standard violation in changed code."
      : `${count} code-standard ${noun} in changed code.`
  )
  return count === 0
}

/**
 * Runs the check for the change the command line names.
 *
 * @remarks Exit status 0 means no violation, 1 at least one violation, and 2
 * that the check could not run, such as for invalid arguments or a git
 * failure.
 */
async function main(): Promise<void> {
  try {
    const source = parseChangeSource(process.argv.slice(2))
    const root = runGit(process.cwd(), ["rev-parse", "--show-toplevel"]).trim()
    const passed = await checkChange(Object.freeze({ root, source }))
    process.exitCode = passed ? 0 : 1
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 2
  }
}

await main()
