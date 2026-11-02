/**
 * Starting and stopping the processes a verification run owns.
 *
 * @remarks A started process runs detached in its own session and process
 * group, with its output appended to a log file, so a `launch` command can
 * exit and leave it running. Every process is recorded with its start time
 * and command line; a stop first checks that the recorded pid still has
 * that start time, so a reused pid is never signalled. The command line is
 * recorded for the reader only: the package binaries under
 * `node_modules/.bin` are shell wrappers that `exec` into Node, which
 * changes the command `ps` shows while the pid and start time stay.
 * Nothing here kills by process name.
 */

import { execFileSync, spawn } from "node:child_process"
import { closeSync, openSync } from "node:fs"
import { waitForCondition } from "./waiting.mjs"

/** Grace given to a process group after `SIGTERM` before `SIGKILL`. */
const STOP_GRACE_MS = 5000

/** Width of the fixed-format `lstart` column `ps` prints. */
const LSTART_WIDTH = 24

/**
 * Identity of a process the run started.
 *
 * @typedef {object} OwnedProcess
 * @property {string} role - Short role of the process, such as `backend`.
 * @property {number} pid - Process identifier, which is also its process
 * group identifier.
 * @property {string} command - Command line as `ps` reported it right after
 * the spawn, for the reader; it may change when a wrapper `exec`s.
 * @property {string} startedAt - Start time as `ps -o lstart` reports it,
 * which with the pid identifies the process.
 * @property {string} logPath - Absolute path of the file that receives its
 * output.
 */

/**
 * Options of {@link startOwnedProcess}.
 *
 * @typedef {object} StartOptions
 * @property {string} role - Short role of the process, such as `backend`.
 * @property {string} command - Absolute path of the executable.
 * @property {readonly string[]} args - Arguments after the command.
 * @property {string} cwd - Working directory.
 * @property {Readonly<Record<string, string | undefined>>} env - Environment;
 * the current environment is not inherited unless passed.
 * @property {string} logPath - Absolute path of the file that receives
 * stdout and stderr.
 */

/**
 * Starts a process detached in its own session with its output appended to
 * a log file.
 *
 * @param {StartOptions} options - Command, arguments, directory,
 * environment, and log file.
 * @returns {Promise<OwnedProcess>} A promise that resolves to the process's
 * recorded identity once `ps` reports its start time.
 * @throws If the process cannot be spawned or exits before `ps` sees it.
 */
export async function startOwnedProcess(options) {
  const logFd = openSync(options.logPath, "a")
  try {
    const child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env: { ...options.env },
      detached: true,
      stdio: ["ignore", logFd, logFd]
    })
    const pid = await waitForSpawn(child)
    child.unref()
    const identity = readProcessIdentity(pid)
    if (identity === undefined) {
      throw new Error(
        `${options.role} (pid ${pid}) exited right after it started; see ${options.logPath}`
      )
    }
    return Object.freeze({
      role: options.role,
      pid,
      ...identity,
      logPath: options.logPath
    })
  } finally {
    closeSync(logFd)
  }
}

/**
 * Reports whether a recorded process is still the one the run started.
 *
 * @param {OwnedProcess} owned - The recorded identity.
 * @returns {boolean} `true` while a process with that pid and start time
 * exists; the command line is not compared because it changes when a
 * shell wrapper `exec`s the real program.
 */
export function isOwnedProcessAlive(owned) {
  const identity = readProcessIdentity(owned.pid)
  return identity !== undefined && identity.startedAt === owned.startedAt
}

/**
 * Stops a recorded process and its process group.
 *
 * @param {OwnedProcess} owned - The recorded identity.
 * @returns {Promise<"absent" | "terminated" | "killed">} A promise that
 * resolves to how the process ended: `absent` when it was already gone,
 * `terminated` after `SIGTERM`, or `killed` after `SIGKILL`.
 */
export async function stopOwnedProcess(owned) {
  if (!isOwnedProcessAlive(owned)) return "absent"
  sendGroupSignal(owned.pid, "SIGTERM")
  const terminated = await waitForProcessEnd(owned, STOP_GRACE_MS)
  if (terminated) return "terminated"
  sendGroupSignal(owned.pid, "SIGKILL")
  await waitForProcessEnd(owned, STOP_GRACE_MS)
  return "killed"
}

/**
 * Waits for a recorded process to disappear.
 *
 * @param {OwnedProcess} owned - The recorded identity.
 * @param {number} timeoutMs - Deadline in milliseconds.
 * @returns {Promise<boolean>} A promise that resolves to `true` once it is
 * gone, else `false`.
 */
export async function waitForProcessEnd(owned, timeoutMs) {
  try {
    await waitForCondition({
      description: `${owned.role} (pid ${owned.pid}) to end`,
      timeoutMs,
      intervalMs: 100,
      check: () => !isOwnedProcessAlive(owned)
    })
    return true
  } catch {
    return false
  }
}

/**
 * Sends a signal to a whole process group, ignoring a group that is gone.
 *
 * @param {number} groupId - Process group identifier.
 * @param {NodeJS.Signals} signal - Signal name.
 * @throws If the signal cannot be sent for a reason other than a missing
 * group.
 */
export function sendGroupSignal(groupId, signal) {
  try {
    process.kill(-groupId, signal)
  } catch (error) {
    if (!isMissingProcessError(error)) throw error
  }
}

/**
 * Reports whether a `process.kill` error means the target is gone.
 *
 * @param {unknown} error - The thrown error.
 * @returns {boolean} `true` for `ESRCH`.
 */
function isMissingProcessError(error) {
  return error instanceof Error && "code" in error && error.code === "ESRCH"
}

/**
 * Reads the command line and start time `ps` reports for a pid.
 *
 * @param {number} pid - Process identifier.
 * @returns {{startedAt: string, command: string} | undefined} The command
 * and start time, or `undefined` when no such process exists.
 */
export function readProcessIdentity(pid) {
  let output
  try {
    output = execFileSync("ps", ["-o", "lstart=,command=", "-p", String(pid)], {
      encoding: "utf8"
    })
  } catch {
    return undefined
  }
  const line = output.trim()
  if (line === "") return undefined
  // `lstart` is a fixed-width timestamp such as "Sat Nov  1 22:52:18 2026",
  // followed by one space and the command.
  return Object.freeze({
    startedAt: line.slice(0, LSTART_WIDTH).trim(),
    command: line.slice(LSTART_WIDTH + 1).trim()
  })
}

/**
 * Resolves a spawned child's pid once Node reports the spawn succeeded.
 *
 * @param {import("node:child_process").ChildProcess} child - The spawned
 * child.
 * @returns {Promise<number>} A promise that resolves to the pid.
 * @throws If spawning fails, with Node's spawn error.
 */
function waitForSpawn(child) {
  return new Promise((resolve, reject) => {
    child.once("spawn", () => resolve(child.pid))
    child.once("error", reject)
  })
}

/**
 * Lists the pids listening on a loopback TCP port.
 *
 * @param {number} port - TCP port.
 * @returns {number[]} Listening pids, empty when nothing listens or `lsof`
 * is unavailable.
 */
export function listListeningPids(port) {
  try {
    const output = execFileSync(
      "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      { encoding: "utf8" }
    )
    return output
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => Number(line.trim()))
  } catch {
    return []
  }
}

/**
 * Reads the process group a pid belongs to.
 *
 * @param {number} pid - Process identifier.
 * @returns {number | undefined} The group identifier, or `undefined` when
 * no such process exists.
 */
export function readProcessGroupId(pid) {
  try {
    const output = execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], {
      encoding: "utf8"
    })
    const group = Number(output.trim())
    return Number.isInteger(group) && group > 0 ? group : undefined
  } catch {
    return undefined
  }
}
