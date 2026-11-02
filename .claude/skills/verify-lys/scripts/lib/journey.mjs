/**
 * Running one journey and recording what it observed.
 *
 * @remarks A journey is a list of named steps against the launched stack.
 * Each step records evidence files under `evidence/<journey>/`; a failed
 * check rejects the step with a {@link JourneyFailure}, a missing
 * precondition with a {@link JourneyBlocked}, and either ends the journey
 * with the remaining steps skipped. Results are plain data for
 * `results.json`.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"

/** A check that did not hold: the behavior under test is wrong. */
export class JourneyFailure extends Error {
  /**
   * @param {string} message - What did not hold.
   * @param {unknown} [detail] - What was observed instead.
   */
  constructor(message, detail) {
    super(
      detail === undefined
        ? message
        : `${message} Observed: ${formatDetail(detail)}`
    )
    this.name = "JourneyFailure"
  }
}

/** A precondition the environment does not meet: nothing was verified. */
export class JourneyBlocked extends Error {
  /**
   * @param {string} message - What is missing and how to provide it.
   */
  constructor(message) {
    super(message)
    this.name = "JourneyBlocked"
  }
}

/**
 * Rejects a step unless a condition holds.
 *
 * @param {unknown} condition - The checked condition.
 * @param {string} message - What must hold, in user terms.
 * @param {unknown} [detail] - What was observed, for the failure message.
 * @throws {JourneyFailure} If the condition is falsy.
 */
export function rejectUnless(condition, message, detail) {
  if (!condition) throw new JourneyFailure(message, detail)
}

/**
 * Evidence recorder of one journey.
 *
 * @typedef {object} EvidenceRecorder
 * @property {(name: string, value: unknown) => string} saveJson - Writes a
 * JSON file and returns its run-relative path.
 * @property {(name: string, text: string) => string} saveText - Writes a
 * text file and returns its run-relative path.
 * @property {(name: string) => string} buildPath - Names a file in the
 * journey's evidence directory for a caller that writes it itself, and
 * records it.
 */

/**
 * Definition of one journey.
 *
 * @typedef {object} JourneyDefinition
 * @property {string} id - Kebab-case identifier used on the command line.
 * @property {string} feature - Feature map file the journey belongs to.
 * @property {string} title - One line of what it proves.
 * @property {boolean} needsRenderer - Whether it drives the UI in Chrome.
 * @property {boolean} needsNative - Whether it runs the real Tauri binary.
 * @property {(steps: StepRunner, context: unknown) => Promise<void>} run -
 * The journey body.
 */

/**
 * Runs the named steps of one journey.
 *
 * @typedef {object} StepRunner
 * @property {(name: string, body: (evidence: EvidenceRecorder) => Promise<unknown>) => Promise<unknown>} step -
 * Runs one step; its resolved value becomes the step's detail.
 */

/**
 * Runs one journey and returns its result record.
 *
 * @param {JourneyDefinition} definition - The journey.
 * @param {unknown} context - Stack facts the journey body receives.
 * @param {string} runRoot - Run directory; evidence paths are relative to it.
 * @returns {Promise<Record<string, unknown>>} The journey's result, ready
 * for `results.json`.
 */
export async function runJourney(definition, context, runRoot) {
  const startedAt = new Date()
  const evidenceDir = join(runRoot, "evidence", definition.id)
  mkdirSync(evidenceDir, { recursive: true })
  const steps = []
  const runner = {
    step: (name, body) =>
      runStep({ name, body, steps, evidenceDir, runRoot, context })
  }
  let failure
  try {
    await definition.run(runner, context)
  } catch (error) {
    failure = error
  }
  return buildJourneyResult({ definition, startedAt, steps, failure })
}

/**
 * Runs one step and appends its record.
 *
 * @param {{name: string, body: Function, steps: object[], evidenceDir: string, runRoot: string, context: unknown}} options -
 * The step, the result list, where evidence goes, and the journey context,
 * whose optional `captureFailure(evidence)` is called when the step fails
 * so a renderer journey can keep a screenshot of what it saw.
 * @returns {Promise<unknown>} The step body's value.
 * @throws Whatever the body throws, after the record is appended.
 */
async function runStep({ name, body, steps, evidenceDir, runRoot, context }) {
  const files = []
  const evidence = buildEvidenceRecorder({
    evidenceDir,
    runRoot,
    prefix: `${String(steps.length + 1).padStart(2, "0")}`,
    files
  })
  const startedAt = Date.now()
  try {
    const detail = await body(evidence)
    steps.push(buildStepRecord(name, "passed", startedAt, files, detail))
    return detail
  } catch (error) {
    const status = error instanceof JourneyBlocked ? "blocked" : "failed"
    await captureFailure(context, evidence)
    steps.push(
      buildStepRecord(name, status, startedAt, files, formatError(error))
    )
    throw error
  }
}

/**
 * Asks the context to keep what it saw when a step failed, ignoring a
 * capture that fails itself.
 *
 * @param {unknown} context - The journey context.
 * @param {EvidenceRecorder} evidence - The failed step's recorder.
 * @returns {Promise<void>} Resolves once captured or given up.
 */
async function captureFailure(context, evidence) {
  if (typeof context?.captureFailure !== "function") return
  try {
    await context.captureFailure(evidence)
  } catch {
    // The failure itself is what matters; a lost screenshot is reported by its absence.
  }
}

/**
 * Builds the record of one finished step.
 *
 * @param {string} name - Step name.
 * @param {"passed" | "failed" | "blocked"} status - Outcome.
 * @param {number} startedAt - Start time in epoch milliseconds.
 * @param {string[]} evidence - Run-relative evidence paths.
 * @param {unknown} detail - The body's value or the error text.
 * @returns {Record<string, unknown>} The step record.
 */
function buildStepRecord(name, status, startedAt, evidence, detail) {
  return {
    name,
    status,
    durationMs: Date.now() - startedAt,
    ...(detail === undefined ? {} : { detail }),
    evidence
  }
}

/**
 * Builds the journey's result from its steps and the error that ended it.
 *
 * @param {{definition: JourneyDefinition, startedAt: Date, steps: object[], failure: unknown}} options -
 * The journey, its start, its step records, and the ending error, if any.
 * @returns {Record<string, unknown>} The result record.
 */
function buildJourneyResult({ definition, startedAt, steps, failure }) {
  let status = "passed"
  if (failure instanceof JourneyBlocked) status = "blocked"
  else if (failure !== undefined) status = "failed"
  return {
    id: definition.id,
    feature: definition.feature,
    title: definition.title,
    status,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    steps,
    ...(failure === undefined ? {} : { failure: formatError(failure) })
  }
}

/**
 * Builds the recorder that writes a step's evidence files.
 *
 * @param {{evidenceDir: string, runRoot: string, prefix: string, files: string[]}} options -
 * Where files go, the step's ordinal prefix, and the list that collects
 * their run-relative paths.
 * @returns {EvidenceRecorder} The recorder.
 */
function buildEvidenceRecorder({ evidenceDir, runRoot, prefix, files }) {
  const buildPath = (name) => {
    const path = join(evidenceDir, `${prefix}-${name}`)
    files.push(relative(runRoot, path))
    return path
  }
  return Object.freeze({
    buildPath,
    saveJson: (name, value) => {
      const path = buildPath(name)
      writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
      return relative(runRoot, path)
    },
    saveText: (name, text) => {
      const path = buildPath(name)
      writeFileSync(path, text)
      return relative(runRoot, path)
    }
  })
}

/**
 * Formats an error for a result record.
 *
 * @param {unknown} error - The thrown value.
 * @returns {string} Its name and message.
 */
function formatError(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

/**
 * Formats an observed value for a failure message.
 *
 * @param {unknown} detail - The observation.
 * @returns {string} JSON, cut to a readable length.
 */
function formatDetail(detail) {
  const text = typeof detail === "string" ? detail : JSON.stringify(detail)
  return text.length > 400 ? `${text.slice(0, 400)}…` : text
}
