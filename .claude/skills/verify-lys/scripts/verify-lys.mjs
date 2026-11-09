#!/usr/bin/env node
/**
 * Command line of the Lys verification harness.
 *
 * @remarks Commands: `launch` starts the stack for a new run, `doctor`
 * observes it without changing it, `drive` runs journeys against it,
 * `cleanup` stops it and deletes its scratch state while keeping evidence,
 * `run` does launch, drive, and cleanup in one go, and `list` names the
 * journeys. Exit codes: 0 every driven journey passed, 1 a journey failed,
 * 2 the harness itself failed, 3 nothing failed but a journey was blocked.
 */

import { parseArgs } from "node:util"
import { fileURLToPath } from "node:url"
import { CdpConnection } from "./lib/cdp.mjs"
import { runJourney } from "./lib/journey.mjs"
import { isOwnedProcessAlive } from "./lib/processControl.mjs"
import { RendererPage } from "./lib/rendererPage.mjs"
import {
  BACKEND_URL,
  RENDERER_URL,
  listMissingTools
} from "./lib/repository.mjs"
import {
  buildRunPaths,
  createRunDirectory,
  findActiveRunId,
  readJsonDocument,
  readRunRecord,
  removeActiveRunId,
  saveActiveRunId,
  saveJsonDocument,
  deleteRunState
} from "./lib/runRecord.mjs"
import {
  collectHomeArtifacts,
  getStackHealth,
  launchStack,
  stopStack
} from "./lib/stack.mjs"
import { JOURNEYS, findJourney } from "./journeys/index.mjs"
import { existsSync } from "node:fs"

/** Exit code when every driven journey passed. */
const EXIT_PASSED = 0

/** Exit code when a journey failed. */
const EXIT_FAILED = 1

/** Exit code when the harness itself failed. */
const EXIT_HARNESS_ERROR = 2

/** Exit code when nothing failed but a journey was blocked. */
const EXIT_BLOCKED = 3

/** Usage text. */
const USAGE = `Usage: node verify-lys.mjs <command> [options]

Commands
  launch                      start the stack for a new run and name it the active run
  doctor [--run <id>]         observe the active run without changing it
  drive [--run <id>] [--native] [--journey <id>]...
                              run journeys (default: every non-native journey) against the active run
  cleanup [--run <id>]        stop the run's processes, copy its Lys home logs, delete its scratch state
  run [--native] [--keep] [--journey <id>]...
                              launch, drive, and cleanup in one go (--keep skips cleanup)
  list                        name the journeys and their features
`

/**
 * Parses the command line.
 *
 * @param {readonly string[]} argv - Arguments after the script path.
 * @returns {{command: string | undefined, options: Record<string, unknown>}}
 * The command and its options.
 */
function parseCommandLine(argv) {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      run: { type: "string" },
      journey: { type: "string", multiple: true },
      native: { type: "boolean", default: false },
      keep: { type: "boolean", default: false }
    }
  })
  return { command: positionals[0], options: values }
}

/**
 * Resolves the run a command works on: the named one or the active one.
 *
 * @param {Record<string, unknown>} options - Parsed options.
 * @returns {{paths: import("./lib/runRecord.mjs").RunPaths, record: Record<string, any>}}
 * The run's paths and record.
 * @throws If no run is named and none is active, or the record is missing.
 */
function resolveRun(options) {
  const id = typeof options.run === "string" ? options.run : findActiveRunId()
  if (id === undefined)
    throw new Error("No active run. Launch one first or pass --run <id>.")
  const paths = buildRunPaths(id)
  if (!existsSync(paths.recordPath))
    throw new Error(`Run ${id} has no run.json under ${paths.root}.`)
  return { paths, record: readRunRecord(paths) }
}

/**
 * Selects the journeys to drive.
 *
 * @param {Record<string, unknown>} options - Parsed options.
 * @returns {import("./lib/journey.mjs").JourneyDefinition[]} The journeys
 * in drive order.
 * @throws If a named journey does not exist.
 */
function selectJourneys(options) {
  const ids = Array.isArray(options.journey) ? options.journey : []
  if (ids.length === 0)
    return JOURNEYS.filter(
      (journey) => !journey.needsNative || options.native === true
    )
  return ids.map((id) => {
    const journey = findJourney(id)
    if (journey === undefined)
      throw new Error(`No journey named ${id}. Run list to see them.`)
    return journey
  })
}

/**
 * Calculates the exit code of a set of journey results.
 *
 * @param {readonly {status: string}[]} results - Journey results.
 * @returns {number} The exit code.
 */
function calculateExitCode(results) {
  if (results.some((result) => result.status === "failed")) return EXIT_FAILED
  if (results.some((result) => result.status === "blocked")) return EXIT_BLOCKED
  return EXIT_PASSED
}

/**
 * Merges new journey results into the run's `results.json`.
 *
 * @param {import("./lib/runRecord.mjs").RunPaths} paths - The run's paths.
 * @param {Record<string, any>} record - The run record.
 * @param {object[]} results - The results just produced, by journey id.
 * @returns {object} The whole results document.
 */
function saveJourneyResults(paths, record, results) {
  const previous = existsSync(paths.resultsPath)
    ? readJsonDocument(paths.resultsPath)
    : { journeys: [] }
  const kept = previous.journeys.filter(
    (entry) => !results.some((result) => result.id === entry.id)
  )
  const journeys = [...kept, ...results]
  const document = {
    runId: paths.id,
    head: record.head,
    dirtyFiles: record.dirtyFiles,
    updatedAt: new Date().toISOString(),
    summary: {
      passed: journeys.filter((entry) => entry.status === "passed").length,
      failed: journeys.filter((entry) => entry.status === "failed").length,
      blocked: journeys.filter((entry) => entry.status === "blocked").length
    },
    journeys
  }
  saveJsonDocument(paths.resultsPath, document)
  return document
}

/**
 * Prints one journey's outcome.
 *
 * @param {Record<string, any>} result - The journey result.
 */
function printJourneyResult(result) {
  const seconds = (result.durationMs / 1000).toFixed(1)
  console.log(`[${result.status}] ${result.id} (${seconds} s)`)
  for (const step of result.steps) {
    const marker =
      step.status === "passed"
        ? "  ✓"
        : step.status === "blocked"
          ? "  ◌"
          : "  ✗"
    console.log(`${marker} ${step.name}`)
    if (step.status !== "passed") console.log(`      ${step.detail}`)
  }
  if (result.failure && result.steps.every((step) => step.status === "passed"))
    console.log(`      ${result.failure}`)
}

/**
 * Drives journeys against a running stack.
 *
 * @param {{paths: import("./lib/runRecord.mjs").RunPaths, record: Record<string, any>, journeys: import("./lib/journey.mjs").JourneyDefinition[], native: boolean}} options -
 * The run, the journeys, and whether native journeys may run.
 * @returns {Promise<object[]>} The journey results.
 */
async function driveJourneys({ paths, record, journeys, native }) {
  const needsRenderer = journeys.some((journey) => journey.needsRenderer)
  const connection = needsRenderer
    ? await CdpConnection.open(record.urls.devTools)
    : undefined
  const pages = { current: undefined }
  const context = Object.freeze({
    paths,
    record,
    native,
    backendUrl: BACKEND_URL,
    rendererUrl: RENDERER_URL,
    hostUrl: record.urls.host,
    providerUrl: record.urls.provider,
    openPage: async () => {
      pages.current = await RendererPage.open({
        connection,
        url: RENDERER_URL,
        hostUrl: record.urls.host
      })
      return pages.current
    },
    captureFailure: async (evidence) => {
      if (pages.current === undefined) return
      await pages.current.captureScreenshot(evidence.buildPath("failure.png"))
      evidence.saveText(
        "failure-page.txt",
        `${await pages.current.evaluate("document.body.innerText")}\n`
      )
    }
  })
  const results = []
  try {
    for (const journey of journeys) {
      console.log(`→ ${journey.id}: ${journey.title}`)
      const result = await runJourney(journey, context, paths.root)
      results.push(result)
      printJourneyResult(result)
    }
  } finally {
    connection?.close()
  }
  return results
}

/**
 * Refuses to launch while another run's processes are alive, and forgets a
 * stale active run.
 *
 * @throws If the active run still has a live process.
 */
function refuseLiveActiveRun() {
  const activeId = findActiveRunId()
  if (activeId === undefined) return
  const paths = buildRunPaths(activeId)
  const record = existsSync(paths.recordPath)
    ? readRunRecord(paths)
    : { processes: {} }
  const alive = Object.entries(record.processes ?? {}).filter(([, owned]) =>
    isOwnedProcessAlive(owned)
  )
  if (alive.length > 0) {
    throw new Error(
      `Run ${activeId} is still active (${alive.map(([role, owned]) => `${role} pid ${owned.pid}`).join(", ")}). Run cleanup first.`
    )
  }
  removeActiveRunId()
}

/**
 * Runs `launch`.
 *
 * @returns {Promise<{paths: import("./lib/runRecord.mjs").RunPaths, record: Record<string, any>}>}
 * The launched run.
 * @throws If the stack cannot be launched; what did start is stopped.
 */
async function runLaunchCommand() {
  refuseLiveActiveRun()
  const paths = createRunDirectory()
  saveActiveRunId(paths.id)
  console.log(`run ${paths.id}`)
  console.log(`  directory ${paths.root}`)
  try {
    const record = await launchStack(paths)
    console.log(`  backend   ${record.urls.backend}`)
    console.log(`  renderer  ${record.urls.renderer}`)
    console.log(`  host      ${record.urls.host}`)
    console.log(`  provider  ${record.urls.provider}`)
    console.log(`  devtools  ${record.urls.devTools}`)
    console.log(`  composer  "${record.warmUp.placeholder}"`)
    return { paths, record }
  } catch (error) {
    console.error(
      `launch failed: ${error instanceof Error ? error.message : String(error)}`
    )
    const outcomes = await stopStack(readRunRecord(paths))
    console.error(`  stopped what had started: ${JSON.stringify(outcomes)}`)
    removeActiveRunId()
    throw error
  }
}

/**
 * Runs `cleanup` for a run.
 *
 * @param {{paths: import("./lib/runRecord.mjs").RunPaths, record: Record<string, any>}} run -
 * The run.
 * @returns {Promise<void>} Resolves once stopped and cleaned.
 */
async function runCleanupCommand({ paths, record }) {
  const outcomes = await stopStack(record)
  const copied = collectHomeArtifacts(paths)
  deleteRunState(paths)
  if (findActiveRunId() === paths.id) removeActiveRunId()
  record.status = "cleaned"
  record.cleanedAt = new Date().toISOString()
  record.stopOutcomes = outcomes
  record.homeArtifacts = copied
  saveJsonDocument(paths.recordPath, record)
  console.log(`cleaned run ${paths.id}: ${JSON.stringify(outcomes)}`)
  console.log(`  evidence kept in ${paths.evidenceDir}`)
  console.log(
    `  logs kept in ${paths.logsDir} (${copied.length} Lys home files copied)`
  )
}

/**
 * Runs `doctor` for a run.
 *
 * @param {Record<string, unknown>} options - Parsed options.
 * @returns {Promise<number>} 0 when the run is worth driving, else 1.
 */
async function runDoctorCommand(options) {
  const facts = {
    node: process.version,
    missingTools: listMissingTools(),
    activeRun: findActiveRunId()
  }
  let drivable = false
  try {
    const { record } = resolveRun(options)
    facts.run = record.id
    facts.stack = await getStackHealth(record)
    drivable =
      record.status === "running" &&
      Object.values(facts.stack.processes).every((entry) => entry.alive) &&
      facts.stack.backendHealth?.ok === true &&
      facts.stack.devTools?.product !== undefined
  } catch (error) {
    facts.error = error instanceof Error ? error.message : String(error)
  }
  facts.drivable = drivable
  console.log(JSON.stringify(facts, null, 2))
  return drivable ? EXIT_PASSED : EXIT_FAILED
}

/**
 * Runs `drive` for a run.
 *
 * @param {Record<string, unknown>} options - Parsed options.
 * @param {{paths: import("./lib/runRecord.mjs").RunPaths, record: Record<string, any>}} run -
 * The run.
 * @returns {Promise<number>} The exit code of the results.
 */
async function runDriveCommand(options, run) {
  if (run.record.status !== "running")
    throw new Error(`Run ${run.paths.id} is ${run.record.status}, not running.`)
  const journeys = selectJourneys(options)
  const results = await driveJourneys({
    ...run,
    journeys,
    native: options.native === true
  })
  const document = saveJourneyResults(run.paths, run.record, results)
  console.log(
    `summary: ${document.summary.passed} passed, ${document.summary.failed} failed, ${document.summary.blocked} blocked`
  )
  console.log(`results ${run.paths.resultsPath}`)
  return calculateExitCode(results)
}

/**
 * Runs `run`: launch, drive, and cleanup unless kept.
 *
 * @param {Record<string, unknown>} options - Parsed options.
 * @returns {Promise<number>} The exit code of the results.
 */
async function runWholeCommand(options) {
  const run = await runLaunchCommand()
  try {
    return await runDriveCommand(options, run)
  } finally {
    if (options.keep === true)
      console.log(`run ${run.paths.id} kept running; cleanup when done`)
    else await runCleanupCommand(run)
  }
}

/**
 * Runs `list`.
 */
function runListCommand() {
  for (const journey of JOURNEYS) {
    const flags = [
      journey.needsRenderer ? "renderer" : "api",
      ...(journey.needsNative ? ["native (--native)"] : [])
    ]
    console.log(`${journey.id}  [${journey.feature}; ${flags.join(", ")}]`)
    console.log(`  ${journey.title}`)
  }
}

/**
 * Runs the command line and returns the exit code.
 *
 * @param {readonly string[]} argv - Arguments after the script path.
 * @returns {Promise<number>} The exit code.
 */
async function runCommandLine(argv) {
  const { command, options } = parseCommandLine(argv)
  switch (command) {
    case "launch":
      await runLaunchCommand()
      return EXIT_PASSED
    case "doctor":
      return await runDoctorCommand(options)
    case "drive":
      return await runDriveCommand(options, resolveRun(options))
    case "cleanup":
      await runCleanupCommand(resolveRun(options))
      return EXIT_PASSED
    case "run":
      return await runWholeCommand(options)
    case "list":
      runListCommand()
      return EXIT_PASSED
    default:
      console.error(USAGE)
      return EXIT_HARNESS_ERROR
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCommandLine(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      )
      process.exit(EXIT_HARNESS_ERROR)
    }
  )
}
