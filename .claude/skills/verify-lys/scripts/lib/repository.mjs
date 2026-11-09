/**
 * Repository locations and tool paths the verification harness depends on.
 *
 * @remarks Every path is derived from this file's own location, so the
 * harness works from any working directory. Nothing here touches the
 * filesystem except {@link readRepositoryState}, which asks git for the
 * current commit and dirty files, and {@link listMissingTools}.
 */

import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/** Absolute path of the repository root. */
export const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../.."
)

/** Absolute path of the skill directory that owns this harness. */
export const SKILL_ROOT = join(REPOSITORY_ROOT, ".claude/skills/verify-lys")

/** Absolute path of the directory that holds every verification run. */
export const RUNS_ROOT = join(REPOSITORY_ROOT, ".agent-work/verify-lys/runs")

/** Absolute path of the backend package. */
export const BACKEND_ROOT = join(REPOSITORY_ROOT, "apps/backend")

/** Absolute path of the desktop package. */
export const DESKTOP_ROOT = join(REPOSITORY_ROOT, "apps/desktop")

/** The `tsx` binary the backend's own `dev` script runs. */
export const TSX_BINARY = join(BACKEND_ROOT, "node_modules/.bin/tsx")

/** The Vite binary the desktop's own `dev` script runs. */
export const VITE_BINARY = join(DESKTOP_ROOT, "node_modules/.bin/vite")

/** The Tauri debug binary that `cargo build` writes. */
export const TAURI_DEBUG_BINARY = join(
  DESKTOP_ROOT,
  "src-tauri/target/debug/lys-desktop"
)

/** Google Chrome, the only browser the harness drives over CDP. */
export const CHROME_BINARY =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

/** Loopback port the backend always binds, from `@lys/protocol`. */
export const BACKEND_PORT = 12345

/** Loopback origin the backend always binds, from `@lys/protocol`. */
export const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`

/** Port the desktop's Vite dev server must use, from `vite.config.ts`. */
export const RENDERER_PORT = 1420

/** Origin the backend's CORS policy admits for the renderer. */
export const RENDERER_URL = `http://localhost:${RENDERER_PORT}`

/** Tauri's bundle identifier, from `tauri.conf.json`. */
export const TAURI_BUNDLE_IDENTIFIER = "com.w3lt.lys-desktop"

/**
 * Facts about the checked-out revision, recorded with every run.
 *
 * @typedef {object} RepositoryState
 * @property {string} head - Full commit hash of `HEAD`.
 * @property {readonly string[]} dirtyFiles - Paths git reports as changed
 * or untracked, in `git status` order.
 */

/**
 * Reads the commit and dirty files of the repository that owns the harness.
 *
 * @returns {RepositoryState} The current `HEAD` hash and every path
 * `git status` lists.
 * @throws If git is unavailable or the directory is not a repository.
 */
export function readRepositoryState() {
  const head = runGit(["rev-parse", "HEAD"]).trim()
  const status = runGit(["status", "--porcelain"])
  const dirtyFiles = status
    .split("\n")
    .filter((line) => line.length > 3)
    .map((line) => line.slice(3))
  return Object.freeze({ head, dirtyFiles })
}

/**
 * Lists which of the harness's required tools are missing.
 *
 * @returns {string[]} Absolute paths of required binaries that do not exist.
 */
export function listMissingTools() {
  return [TSX_BINARY, VITE_BINARY, CHROME_BINARY].filter(
    (path) => !existsSync(path)
  )
}

/**
 * Runs one git command in the repository root.
 *
 * @param {readonly string[]} args - Arguments after `git`.
 * @returns {string} The command's standard output.
 * @throws If git exits with a failure.
 */
function runGit(args) {
  return execFileSync("git", [...args], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8"
  })
}
