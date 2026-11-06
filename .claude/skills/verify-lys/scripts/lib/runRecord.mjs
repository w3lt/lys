/**
 * The on-disk record of one verification run.
 *
 * @remarks A run owns one directory under `.agent-work/verify-lys/runs/`
 * named by its identifier. `run.json` records what was started and where,
 * `results.json` what the journeys observed, `evidence/` keeps the proofs,
 * `logs/` the process output, and `state/` the scratch Lys home and browser
 * profile that cleanup deletes. One file beside the runs, `active-run`,
 * names the run whose stack is launched, so a second launch can refuse to
 * double-drive the backend's single port.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { dirname, join } from "node:path"
import { RUNS_ROOT } from "./repository.mjs"

/** File beside the runs that names the launched run. */
const ACTIVE_RUN_PATH = join(RUNS_ROOT, "active-run")

/**
 * Directories and files of one run.
 *
 * @typedef {object} RunPaths
 * @property {string} id - Run identifier, also the directory name.
 * @property {string} root - Absolute path of the run directory.
 * @property {string} recordPath - `run.json`.
 * @property {string} resultsPath - `results.json`.
 * @property {string} evidenceDir - Directory of the proofs, kept by cleanup.
 * @property {string} logsDir - Directory of the process logs, kept by cleanup.
 * @property {string} stateDir - Scratch state, deleted by cleanup.
 * @property {string} lysHome - Scratch `LYS_HOME` inside the state.
 * @property {string} chromeProfile - Scratch browser profile inside the state.
 */

/**
 * Builds the paths of a run from its identifier without touching the disk.
 *
 * @param {string} id - Run identifier.
 * @returns {RunPaths} The run's directories and files.
 */
export function buildRunPaths(id) {
  const root = join(RUNS_ROOT, id)
  const stateDir = join(root, "state")
  return Object.freeze({
    id,
    root,
    recordPath: join(root, "run.json"),
    resultsPath: join(root, "results.json"),
    evidenceDir: join(root, "evidence"),
    logsDir: join(root, "logs"),
    stateDir,
    lysHome: join(stateDir, "lys-home"),
    chromeProfile: join(stateDir, "chrome-profile")
  })
}

/**
 * Creates the directories of a new run named by the current time.
 *
 * @returns {RunPaths} The new run's paths; every directory exists.
 * @throws If a directory cannot be created.
 */
export function createRunDirectory() {
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-").slice(0, 19)
  const suffix = Math.random().toString(16).slice(2, 6)
  const paths = buildRunPaths(`${stamp}-${suffix}`)
  for (const directory of [
    paths.evidenceDir,
    paths.logsDir,
    paths.lysHome,
    paths.chromeProfile
  ])
    mkdirSync(directory, { recursive: true })
  return paths
}

/**
 * Writes a JSON document, creating its directory.
 *
 * @param {string} path - Absolute path of the file.
 * @param {unknown} value - The document.
 */
export function saveJsonDocument(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

/**
 * Reads a JSON document.
 *
 * @param {string} path - Absolute path of the file.
 * @returns {unknown} The parsed document.
 * @throws If the file is missing or not JSON.
 */
export function readJsonDocument(path) {
  return JSON.parse(readFileSync(path, "utf8"))
}

/**
 * Reads the record of a run.
 *
 * @param {RunPaths} paths - The run's paths.
 * @returns {Record<string, unknown>} The `run.json` document.
 * @throws If the run has no record yet.
 */
export function readRunRecord(paths) {
  return readJsonDocument(paths.recordPath)
}

/**
 * Finds the identifier of the launched run, if any.
 *
 * @returns {string | undefined} The run identifier named by `active-run`.
 */
export function findActiveRunId() {
  if (!existsSync(ACTIVE_RUN_PATH)) return undefined
  const id = readFileSync(ACTIVE_RUN_PATH, "utf8").trim()
  return id === "" ? undefined : id
}

/**
 * Names a run as the launched one.
 *
 * @param {string} id - Run identifier.
 */
export function saveActiveRunId(id) {
  mkdirSync(RUNS_ROOT, { recursive: true })
  writeFileSync(ACTIVE_RUN_PATH, `${id}\n`)
}

/**
 * Forgets the launched run.
 */
export function removeActiveRunId() {
  rmSync(ACTIVE_RUN_PATH, { force: true })
}

/**
 * Lists the identifiers of every recorded run, newest last.
 *
 * @returns {string[]} Run identifiers, which sort by start time.
 */
export function listRunIds() {
  if (!existsSync(RUNS_ROOT)) return []
  return readdirSync(RUNS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

/**
 * Deletes a run's scratch state, keeping its evidence, logs, and records.
 *
 * @param {RunPaths} paths - The run's paths.
 */
export function deleteRunState(paths) {
  rmSync(paths.stateDir, { recursive: true, force: true })
}
