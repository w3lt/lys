import { ChildProcess } from "node:child_process"
import { constants } from "node:os"

/**
 * Error code of a start that Node gives up before it creates the process's
 * pipes: the backend has no file descriptor left (`EMFILE`), or the system
 * has none (`ENFILE`).
 */
export type FileDescriptorShortage = "EMFILE" | "ENFILE"

/**
 * Process object of a start Node gave up: a `ChildProcess` that never
 * started a process, so it has no pid and no standard streams.
 *
 * @remarks Owns only the state its base class keeps, to stand in for the
 * process object `spawn` returns for such a start, while preserving its
 * invariant: it starts no process, and its `kill` sends no signal. The
 * subclass preserves Node's `ChildProcess` contract for a process that
 * never started. It replaces only `kill`. Node's own `kill` would signal
 * through the native handle the base class creates, a handle that never
 * started a process; on Node v24.19.0, that signal reaches every process
 * in the calling process's group. As the replacement is part of the
 * class, it holds for the object's whole life, not only until the runner
 * restores a case's mocks. Resource ownership: it owns no process, pipe,
 * or file descriptor, so it has nothing to release. Concurrency model:
 * single-owner, in one test. It is not designed for subclassing.
 */
class UnstartedChildProcess extends ChildProcess {
  /**
   * Sends no signal, as there is no process.
   *
   * @returns False, as Node's `kill` answers once the failed start closed
   * the process's handle.
   */
  public override kill(): boolean {
    return false
  }
}

/**
 * Creates what Node's `spawn` returns when it finds no file descriptor for
 * the process's pipes, for a case that replaces `spawn` with it.
 *
 * @param command - Command the case was asked to start.
 * @param args - Its arguments.
 * @param shortage - Which file descriptors ran out.
 * @returns A process that never started. On the next tick, it emits `error`
 * with Node's error for the failed start, then `close` with the negative
 * error number as exit code and no signal; it never emits `exit`.
 * @remarks Mirrors `lib/internal/child_process.js` of Node v24.19.0, read
 * from the running Node's built-in sources: for `EMFILE` and `ENFILE`,
 * `ChildProcess.prototype.spawn` queues `onErrorNT` on the next tick and
 * returns before it creates the pipes, so `stdin`, `stdout`, `stderr`, and
 * `stdio` stay undefined. `onErrorNT` calls the handle's `onexit` with the
 * negative error number as exit code; `onexit` emits `error` with an
 * `ErrnoException` instead of `exit` for a negative code, and `maybeClose`
 * then emits `close` at once, as no pipe is left to wait for. A real
 * `spawn` under `ulimit -n 64` emitted the same events, in this order, with
 * an error of the same fields: `errno`, `code`, `syscall`, `path`, and
 * `spawnargs`. Unlike Node's, the process leaves `exitCode`, `spawnfile`,
 * and `spawnargs` unset, so a case must not depend on them. Both events are
 * emitted in one callback on the next tick, so nothing it schedules
 * outlives a case that waits for them.
 */
export function createUnstartedChildProcess(
  command: string,
  args: readonly string[],
  shortage: FileDescriptorShortage
): ChildProcess {
  const child = new UnstartedChildProcess()
  const startError = buildFailedStartError(command, args, shortage)
  process.nextTick(() => {
    child.emit("error", startError)
    child.emit("close", startError.errno, null)
  })
  return child
}

/**
 * Builds Node's error for a start that found no file descriptor for the
 * process's pipes.
 *
 * @param command - Command the case was asked to start.
 * @param args - Its arguments.
 * @param shortage - Which file descriptors ran out.
 * @returns An error with Node's message, `spawn <command> <code>`, and Node's
 * fields: the negative error number as `errno`, the code as `code`,
 * `spawn <command>` as `syscall`, the command as `path`, and a copy of the
 * arguments as `spawnargs`.
 */
function buildFailedStartError(
  command: string,
  args: readonly string[],
  shortage: FileDescriptorShortage
): NodeJS.ErrnoException & { errno: number; spawnargs: string[] } {
  const syscall = `spawn ${command}`
  return Object.assign(new Error(`${syscall} ${shortage}`), {
    errno: -constants.errno[shortage],
    code: shortage,
    syscall,
    path: command,
    spawnargs: [...args]
  })
}
