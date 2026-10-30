import { setTimeout as waitFor } from "node:timers/promises"

/** Time between two checks of whether a process group still runs. */
const PROCESS_GROUP_POLL_MILLISECONDS = 25

/** Code of the failure `kill` reports when no process has the identifier. */
const NO_SUCH_PROCESS = "ESRCH"

/** Code of the failure `kill` reports when no process found may be signalled. */
const NOT_PERMITTED = "EPERM"

/**
 * Owns the identifiers of the process groups the stdio MCP servers run in,
 * so that every group still running can be ended at once when the backend
 * stops.
 *
 * @remarks Each stdio server's command runs in a process group of its own,
 * which the backend's own process group, the one the desktop host ends,
 * does not hold; the processes the command starts join that group unless
 * they leave it themselves. A group is added once its command started and
 * removed once no process of it is left, or once its stop gave up after
 * `SIGKILL`. {@link stopEveryGroup} is the backend's last resort when it
 * exits: it sends `SIGKILL` to every group still held, without waiting,
 * because an exiting process cannot wait.
 * Resource ownership: owns the identifiers, not the processes; each group's
 * {@link McpServerProcess} ends its own group normally. Concurrency model:
 * single-threaded on the backend's event loop.
 */
export default class McpServerProcessGroups {
  /** Identifiers of the groups that may still run, each its leader's pid. */
  readonly #groupIds: Set<number>

  /** Creates an owner that holds no group. */
  public constructor() {
    this.#groupIds = new Set()
  }

  /**
   * Holds one group that started.
   *
   * @param groupId - Identifier of the group, the pid of the command's
   * process, which leads it.
   */
  public add(groupId: number): void {
    this.#groupIds.add(groupId)
  }

  /**
   * Forgets one group no process of which is left.
   *
   * @param groupId - Identifier of the group.
   */
  public remove(groupId: number): void {
    this.#groupIds.delete(groupId)
  }

  /**
   * Sends `SIGKILL` to every group still held and forgets them all.
   *
   * @returns What `kill` threw for each group it could not signal for a
   * reason other than the group having ended or holding no process the
   * backend may signal, for the caller to log; usually empty.
   * @remarks Synchronous, so it can run while the backend exits. A failure
   * to signal one group does not stop the others.
   */
  public stopEveryGroup(): readonly unknown[] {
    const failures: unknown[] = []
    for (const groupId of this.#groupIds) {
      try {
        sendProcessGroupSignal(groupId, "SIGKILL")
      } catch (error) {
        failures.push(error)
      }
    }
    this.#groupIds.clear()
    return failures
  }
}

/**
 * Sends one signal to every process of a group that may receive it.
 *
 * @param groupId - Identifier of the group.
 * @param signal - Signal to send.
 * @throws What `kill` throws for a reason other than `ESRCH`, when no
 * process of the group is left, or `EPERM`, when none left may receive it,
 * which macOS also reports for a group whose processes all exited but were
 * not yet reaped; {@link hasProcessGroup} tells whether such a group ends.
 */
export function sendProcessGroupSignal(
  groupId: number,
  signal: NodeJS.Signals
): void {
  try {
    process.kill(-groupId, signal)
  } catch (error) {
    const code = findKillFailureCode(error)
    if (code !== NO_SUCH_PROCESS && code !== NOT_PERMITTED) throw error
  }
}

/**
 * Answers whether any process of a group is left.
 *
 * @param groupId - Identifier of the group.
 * @returns False once no process of the group is left; true while one is,
 * a process that exited but was not yet reaped by its parent included.
 * @throws What `kill` throws for a reason other than `ESRCH` or `EPERM`.
 */
export function hasProcessGroup(groupId: number): boolean {
  try {
    process.kill(-groupId, 0)
    return true
  } catch (error) {
    const code = findKillFailureCode(error)
    if (code === NO_SUCH_PROCESS) return false
    if (code === NOT_PERMITTED) return true
    throw error
  }
}

/**
 * Waits until no process of a group is left, or a time limit passes.
 *
 * @param groupId - Identifier of the group.
 * @param milliseconds - Longest the wait may take.
 * @returns True once {@link hasProcessGroup} finds no process of the group,
 * checked every {@link PROCESS_GROUP_POLL_MILLISECONDS} milliseconds; false
 * when the limit passed first.
 * @throws What {@link hasProcessGroup} throws.
 * @remarks Each check runs after the one before has finished, and the limit
 * is read from the monotonic clock, not from the number of checks.
 */
export async function waitForProcessGroupEnd(
  groupId: number,
  milliseconds: number
): Promise<boolean> {
  return waitForProcessGroupEndBefore(groupId, performance.now() + milliseconds)
}

/**
 * Waits until no process of a group is left, or a moment passes.
 *
 * @param groupId - Identifier of the group.
 * @param deadline - Moment on the monotonic clock, as `performance.now()`
 * reads it, after which the wait gives up.
 * @returns True once {@link hasProcessGroup} finds no process of the group;
 * false when the deadline passed first.
 * @throws What {@link hasProcessGroup} throws.
 */
async function waitForProcessGroupEndBefore(
  groupId: number,
  deadline: number
): Promise<boolean> {
  if (!hasProcessGroup(groupId)) return true
  if (performance.now() >= deadline) return false
  await waitFor(PROCESS_GROUP_POLL_MILLISECONDS)
  return waitForProcessGroupEndBefore(groupId, deadline)
}

/**
 * Finds the code of a failure `kill` threw.
 *
 * @param error - What `kill` threw.
 * @returns Its `code`, such as `ESRCH`, or undefined when it has none.
 */
function findKillFailureCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined
}
