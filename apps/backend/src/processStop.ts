import type { FastifyBaseLogger } from "fastify"
import type { EventEmitter } from "node:events"
import { constants } from "node:os"

/** Signals that stop the backend after it ended the MCP servers' processes. */
const STOP_SIGNALS = Object.freeze(["SIGTERM", "SIGINT", "SIGHUP"] as const)

/** Base a signal's number is added to for the exit code it stops with. */
const SIGNAL_EXIT_CODE_BASE = 128

/** What the backend's stop on a signal or exit borrows. */
export type BackendStopDependencies = Readonly<{
  /** The backend's process, whose `exit` and signal events are listened to. */
  backendProcess: EventEmitter
  /** Ends the backend's process with an exit code; never returns in production. */
  exitProcess: (code: number) => void
  /** The backend's logger, which writes each line synchronously. */
  logger: FastifyBaseLogger
  /**
   * Sends `SIGKILL` at once to every process group a stdio MCP server runs
   * in, returning what it could not signal.
   */
  stopEveryMcpServerProcess: () => readonly unknown[]
}>

/**
 * Makes every way the backend's process ends also end the stdio MCP
 * servers' process groups, which the desktop host's stop of the backend's
 * own group does not reach.
 *
 * @param dependencies - The process, its exit, the logger, and the stop of
 * the MCP servers' groups; borrowed for the life of the process.
 * @remarks On `SIGTERM`, which the desktop host sends first when it stops
 * the backend, and on `SIGINT` and `SIGHUP`, which a terminal sends in
 * development, the backend logs the signal, ends the groups, and exits with
 * 128 plus the signal's number, as a process the signal ended would. On
 * `exit`, for any other end Node runs listeners for, such as a failure
 * nothing caught, it ends the groups too; the groups are already gone after
 * a signal, so each ends once. A backend killed with `SIGKILL` runs nothing:
 * its servers then see their standard input close. Call once per process.
 */
export function registerBackendStopHandlers(
  dependencies: BackendStopDependencies
): void {
  const { backendProcess, exitProcess, logger } = dependencies
  backendProcess.on("exit", () => stopMcpServerProcesses(dependencies))
  for (const signal of STOP_SIGNALS) {
    backendProcess.on(signal, () => {
      logger.info({ signal }, "The Lys backend is stopping on a signal")
      stopMcpServerProcesses(dependencies)
      exitProcess(SIGNAL_EXIT_CODE_BASE + constants.signals[signal])
    })
  }
}

/**
 * Ends every MCP server's process group and logs each group that could
 * not be signalled.
 *
 * @param dependencies - The stop of the groups and the logger.
 */
function stopMcpServerProcesses(dependencies: BackendStopDependencies): void {
  for (const failure of dependencies.stopEveryMcpServerProcess())
    dependencies.logger.error(
      { err: failure },
      "An MCP server's process group could not be ended as the backend stopped"
    )
}
