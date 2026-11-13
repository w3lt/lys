import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { describe, it } from "node:test"

/** Absolute path of the command under test. */
const scriptPath = join(import.meta.dirname, "..", "check-changed-code.mts")

/**
 * Runs the changed-code check with the given arguments.
 *
 * @param args - Arguments after the script path.
 * @returns The exit status and standard error.
 */
function runCheck(...args: readonly string[]): {
  readonly status: number | null
  readonly stderr: string
} {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8"
  })
  return Object.freeze({ status: result.status, stderr: result.stderr })
}

describe("check-changed-code command line", () => {
  it("exits with status 2 and the usage when no change source is named", () => {
    const { status, stderr } = runCheck()

    assert.equal(status, 2)
    assert.match(stderr, /^Usage: /)
  })

  it("exits with status 2 when both change sources are named", () => {
    const { status, stderr } = runCheck("--staged", "--base", "origin/main")

    assert.equal(status, 2)
    assert.match(stderr, /^Usage: /)
  })

  it("exits with status 2 when the base names no commit", () => {
    const { status, stderr } = runCheck("--base", "refs/heads/no-such-branch")

    assert.equal(status, 2)
    assert.match(stderr, /^--base names no commit: refs\/heads\/no-such-branch/)
  })

  it("does not pass a base that looks like an option to git as one", () => {
    const { status, stderr } = runCheck("--base=--output=changed.txt")

    assert.equal(status, 2)
    assert.match(stderr, /^--base names no commit: --output=changed.txt/)
  })
})
