import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { devNull, tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it, type TestContext } from "node:test"
import { pathToFileURL } from "node:url"

/** Absolute path of the command under test. */
const scriptPath = join(import.meta.dirname, "..", "check-changed-code.mts")

/** Git executable the tests set repositories up with, as the check runs it. */
const gitPath = "/usr/bin/git"

/** Exit status and output of one run of the check. */
type CheckRun = {
  /** Exit status, or `null` when a signal ended the process. */
  readonly status: number | null

  /** Standard output: the summary line. */
  readonly stdout: string

  /** Standard error: one line per violation, or the failure. */
  readonly stderr: string
}

/**
 * Environment of every process the tests start: no user or system git
 * configuration, no repository inherited from a running git hook, and a fixed
 * author and committer.
 */
const isolatedEnvironment = Object.freeze({
  ...Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))
  ),
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid"
})

/**
 * ESLint configuration of a test repository: the plugin's rules, as the
 * repository configures them, on TypeScript files.
 */
const eslintConfigSource = [
  `import tseslint from ${JSON.stringify(import.meta.resolve("typescript-eslint"))}`,
  `import * as standards from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "..", "plugin.mts")).href)}`,
  "export default [{",
  '  files: ["**/*.ts"],',
  "  languageOptions: { parser: tseslint.parser },",
  "  plugins: { [standards.codeStandardsPluginName]: standards.codeStandardsPlugin },",
  "  rules: standards.codeStandardsRuleLevels",
  "}]",
  ""
].join("\n")

/** Function with two positional parameters, which no plugin rule reports. */
const compliantFunction = [
  "export function pair(first: number, second: number): number {",
  "  return first + second",
  "}",
  ""
].join("\n")

/** Function with four positional parameters, which `lys/func-004` reports. */
const violatingFunction = [
  "export function quad(a: number, b: number, c: number, d: number): number {",
  "  return a + b + c + d",
  "}",
  ""
].join("\n")

/**
 * Runs the changed-code check.
 *
 * @param cwd - Directory the check runs in.
 * @param args - Arguments after the script path.
 * @returns The exit status and output.
 */
function runCheck(cwd: string, ...args: readonly string[]): CheckRun {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    encoding: "utf8",
    env: isolatedEnvironment
  })
  const { status, stdout, stderr } = result
  return Object.freeze({ status, stdout, stderr })
}

/**
 * Runs git in a test repository.
 *
 * @param root - Repository directory.
 * @param args - Arguments after `git`.
 * @throws If git exits with a failure status.
 */
function git(root: string, ...args: readonly string[]): void {
  execFileSync(gitPath, args, { cwd: root, env: isolatedEnvironment })
}

/**
 * Writes a file of a test repository.
 *
 * @param root - Repository directory.
 * @param path - Repository-relative path.
 * @param text - File content.
 */
function writeSource(root: string, path: string, text: string): void {
  writeFileSync(join(root, path), text)
}

/**
 * Creates a repository on branch `main` whose first commit holds the ESLint
 * configuration and `kept.ts`, and removes it when the test ends.
 *
 * @param context - Test that owns the repository.
 * @param keptSource - Content of `kept.ts`.
 * @returns The repository directory.
 */
function createRepository(context: TestContext, keptSource: string): string {
  const root = mkdtempSync(join(tmpdir(), "check-changed-code-"))
  context.after(() => rmSync(root, { recursive: true, force: true }))
  git(root, "init", "--quiet", "--initial-branch=main")
  writeSource(root, "eslint.config.mjs", eslintConfigSource)
  writeSource(root, "kept.ts", keptSource)
  git(root, "add", ".")
  git(root, "commit", "--quiet", "--message=Start")
  return root
}

/**
 * Leaves a repository in a merge of `main` into `feature` whose conflict in
 * `kept.ts` is not yet resolved. `main` adds a violating function, and both
 * branches change the line `return first + second`.
 *
 * @param context - Test that owns the repository.
 * @returns The repository directory.
 * @throws If the merge did not stop with the conflict.
 */
function createConflictedMerge(context: TestContext): string {
  const root = createRepository(context, compliantFunction)
  git(root, "branch", "feature")
  const mainVersion = compliantFunction.replace("+ second", "- second")
  writeSource(root, "kept.ts", `${mainVersion}\n${violatingFunction}`)
  git(root, "commit", "--quiet", "--all", "--message=Main")
  git(root, "switch", "--quiet", "feature")
  const featureVersion = compliantFunction.replace("+ second", "* second")
  writeSource(root, "kept.ts", featureVersion)
  git(root, "commit", "--quiet", "--all", "--message=Feature")
  spawnSync(gitPath, ["merge", "--quiet", "main"], {
    cwd: root,
    env: isolatedEnvironment
  })
  git(root, "rev-parse", "--quiet", "--verify", "MERGE_HEAD")
  return root
}

describe("check-changed-code command line", () => {
  it("exits with status 2 and the usage when no change source is named", () => {
    const { status, stderr } = runCheck(import.meta.dirname)

    assert.equal(status, 2)
    assert.match(stderr, /^Usage: /)
  })

  it("exits with status 2 when both change sources are named", () => {
    const { status, stderr } = runCheck(
      import.meta.dirname,
      "--staged",
      "--base",
      "origin/main"
    )

    assert.equal(status, 2)
    assert.match(stderr, /^Usage: /)
  })

  it("exits with status 2 when the base names no commit", () => {
    const { status, stderr } = runCheck(
      import.meta.dirname,
      "--base",
      "refs/heads/no-such-branch"
    )

    assert.equal(status, 2)
    assert.match(stderr, /^--base names no commit: refs\/heads\/no-such-branch/)
  })

  it("does not pass a base that looks like an option to git as one", () => {
    const { status, stderr } = runCheck(
      import.meta.dirname,
      "--base=--output=changed.txt"
    )

    assert.equal(status, 2)
    assert.match(stderr, /^--base names no commit: --output=changed.txt/)
  })
})

describe("check-changed-code on staged changes", () => {
  it("fails on a violation in a staged file", (context) => {
    const root = createRepository(context, compliantFunction)
    writeSource(root, "added.ts", violatingFunction)
    git(root, "add", "added.ts")

    const { status, stderr } = runCheck(root, "--staged")

    assert.equal(status, 1)
    assert.match(stderr, /^added\.ts:1:8 .*\(lys\/func-004\)$/m)
  })

  it("passes a change outside a construct that already violates a rule", (context) => {
    const root = createRepository(
      context,
      `${violatingFunction}\n${compliantFunction}`
    )
    const changed = `${violatingFunction}\n${compliantFunction.replace("+ second", "- second")}`
    writeSource(root, "kept.ts", changed)
    git(root, "add", "kept.ts")

    const { status, stdout } = runCheck(root, "--staged")

    assert.equal(status, 0)
    assert.match(stdout, /^No code-standard violation in changed code\./)
  })

  it("finds the changed files whatever diff prefixes the user configures", (context) => {
    const root = createRepository(context, compliantFunction)
    git(root, "config", "diff.noprefix", "true")
    git(root, "config", "diff.mnemonicPrefix", "true")
    writeSource(root, "added.ts", violatingFunction)
    git(root, "add", "added.ts")

    const { status } = runCheck(root, "--staged")

    assert.equal(status, 1)
  })

  it("checks a file whose name contains a space", (context) => {
    const root = createRepository(context, compliantFunction)
    writeSource(root, "with space.ts", violatingFunction)
    git(root, "add", "with space.ts")

    const { status, stderr } = runCheck(root, "--staged")

    assert.equal(status, 1)
    assert.match(stderr, /^with space\.ts:1:8 /m)
  })

  it("skips the lines a merge resolution keeps from either branch", (context) => {
    const root = createConflictedMerge(context)
    const resolution = compliantFunction.replace("+ second", "/ second")
    writeSource(root, "kept.ts", `${resolution}\n${violatingFunction}`)
    git(root, "add", "kept.ts")

    const { status } = runCheck(root, "--staged")

    assert.equal(status, 0)
  })

  it("fails on a violation that a merge resolution writes", (context) => {
    const root = createConflictedMerge(context)
    const resolution = violatingFunction.replace("quad", "pair")
    writeSource(root, "kept.ts", `${resolution}\n${violatingFunction}`)
    git(root, "add", "kept.ts")

    const { status, stdout } = runCheck(root, "--staged")

    assert.equal(status, 1)
    assert.match(stdout, /^1 code-standard violation in changed code\./)
  })
})

describe("check-changed-code against a base", () => {
  it("fails on a violation in an untracked file", (context) => {
    const root = createRepository(context, compliantFunction)
    writeSource(root, "untracked.ts", violatingFunction)

    const { status, stderr } = runCheck(root, "--base", "main")

    assert.equal(status, 1)
    assert.match(stderr, /^untracked\.ts:1:8 /m)
  })

  it("passes when nothing changed since the base", (context) => {
    const root = createRepository(context, violatingFunction)

    const { status } = runCheck(root, "--base", "main")

    assert.equal(status, 0)
  })
})
