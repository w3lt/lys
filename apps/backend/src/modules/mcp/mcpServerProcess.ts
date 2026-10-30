import {
  SdkError,
  SdkErrorCode,
  serializeMessage,
  type JSONRPCMessage
} from "@modelcontextprotocol/client"
import { getDefaultEnvironment } from "@modelcontextprotocol/client/stdio"
import { spawn, type ChildProcessByStdio } from "node:child_process"
import type { Readable, Writable } from "node:stream"
import McpServerLogLines from "./mcpServerLogLines"
import McpServerMessageLines, {
  type McpServerMessageHandlers
} from "./mcpServerMessageLines"
import type McpServerProcessGroups from "./mcpServerProcessGroups"
import {
  sendProcessGroupSignal,
  waitForProcessGroupEnd
} from "./mcpServerProcessGroups"

/** The command of one stdio MCP server, as its settings name it. */
export type McpServerCommand = Readonly<{
  /** Program to run, found on the `PATH` of the environment below. */
  command: string
  /** Arguments passed to the program as they are, without a shell. */
  arguments: readonly string[]
  /** Variables set on top of the SDK's default environment. */
  environment: Readonly<Record<string, string>>
  /** Folder the program starts in. */
  workingDirectory: string
}>

/** What a started server's process reports to its owner. */
export type McpServerProcessHandlers = Pick<
  McpServerMessageHandlers,
  "handleMessage" | "handleError"
> &
  Readonly<{
    /**
     * Told once, when the command's process has exited and every holder of
     * its standard streams has closed them, whether or not Lys stopped it.
     */
    handleClose: () => void
  }>

/** What a server's process borrows for its lifetime. */
export type McpServerProcessContext = McpServerMessageHandlers &
  McpServerProcessHandlers &
  Readonly<{
    /** Holds the process group while it may run. */
    processGroups: McpServerProcessGroups
    /** Receives each line the server writes to its standard error, cut to a bound. */
    reportServerLogLine: (line: string) => void
  }>

/** The process with its three standard streams piped. */
type PipedChildProcess = ChildProcessByStdio<Writable, Readable, Readable>

/**
 * Longest each step of a stop waits for the process group to end before
 * the next, stronger step: after standard input closes, after `SIGTERM`,
 * and after `SIGKILL`.
 */
export const MCP_SERVER_STOP_STEP_MILLISECONDS = 2000

/**
 * Owns the process group one stdio MCP server runs in: the process its
 * command started, which leads the group, and every process that one
 * starts and that stays in the group, such as the server a launcher like
 * `npx` or `uvx` runs.
 *
 * @remarks Created by {@link McpServerProcess.start}, which returns once
 * the command's process started in a new session and process group of its
 * own, held by the {@link McpServerProcessGroups} until no process of it is
 * left or its stop gave up after `SIGKILL`. Standard output is read as message lines, standard error as log
 * lines, and messages are written to standard input. {@link stop} ends the
 * whole group: it closes standard input, sends `SIGTERM` to the group after
 * {@link MCP_SERVER_STOP_STEP_MILLISECONDS} and `SIGKILL` after as long
 * again, and settles only once no process of the group is left, reaped
 * included; the command's own exit does not count, because its descendants
 * may still run. A process that leaves the group, such as one that starts
 * a session of its own, is not owned. Resource ownership: owns the process
 * group and the three pipes. Concurrency model: single-owner; one transport
 * starts, writes to, and stops it, and every stop shares the first one.
 */
export default class McpServerProcess {
  /** The command's process, which leads the group; owned. */
  readonly #child: PipedChildProcess
  /** Identifier of the group, the pid of the command's process. */
  readonly #groupId: number
  /** Holder of the group while it may run; borrowed. */
  readonly #processGroups: McpServerProcessGroups
  /** Completion of the first stop, shared by every later stop. */
  #stopping: Promise<void> | undefined

  /**
   * Keeps a process that started.
   *
   * @param child - The started process; owned from here on.
   * @param groupId - Its pid, which identifies its group.
   * @param processGroups - Holder of the group; borrowed.
   */
  private constructor(
    child: PipedChildProcess,
    groupId: number,
    processGroups: McpServerProcessGroups
  ) {
    this.#child = child
    this.#groupId = groupId
    this.#processGroups = processGroups
    this.#stopping = undefined
  }

  /**
   * Starts a server's command in a new process group.
   *
   * @param command - The command, its arguments, variables, and folder.
   * @param context - Holder of the group and the receivers of what the
   * process writes and of its close, borrowed for its lifetime.
   * @returns The running process, whose output reaches the context from
   * here on.
   * @throws Node's failure to start the command, such as `spawn npx ENOENT`,
   * which holds the command's arguments; nothing is left running then.
   */
  public static start(
    command: McpServerCommand,
    context: McpServerProcessContext
  ): Promise<McpServerProcess> {
    const child = spawn(command.command, [...command.arguments], {
      cwd: command.workingDirectory,
      env: { ...getDefaultEnvironment(), ...command.environment },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      shell: false
    })
    const starting = Promise.withResolvers<McpServerProcess>()
    child.once("error", starting.reject)
    child.once("spawn", () => {
      child.off("error", starting.reject)
      McpServerProcess.#handleSpawn(child, context, starting)
    })
    return starting.promise
  }

  /**
   * Settles a start once its process spawned.
   *
   * @param child - The process that spawned.
   * @param context - Holder of the group and the receivers.
   * @param starting - The start to settle: resolved with the owner of the
   * process, or rejected, after the process was killed, in the case Node
   * gives a spawned process no pid.
   */
  static #handleSpawn(
    child: PipedChildProcess,
    context: McpServerProcessContext,
    starting: Pick<PromiseWithResolvers<McpServerProcess>, "resolve" | "reject">
  ): void {
    if (child.pid === undefined) {
      child.kill("SIGKILL")
      starting.reject(new Error("The MCP server's process has no identifier."))
      return
    }
    starting.resolve(McpServerProcess.#createStarted(child, child.pid, context))
  }

  /**
   * Keeps a process that just started and connects its streams.
   *
   * @param child - The started process.
   * @param groupId - Its pid, which identifies its group; never 0, which
   * would name the backend's own group.
   * @param context - Holder of the group and the receivers.
   * @returns The owner of the process and its group.
   */
  static #createStarted(
    child: PipedChildProcess,
    groupId: number,
    context: McpServerProcessContext
  ): McpServerProcess {
    context.processGroups.add(groupId)
    const messageLines = new McpServerMessageLines(context)
    const logLines = new McpServerLogLines(context.reportServerLogLine)
    child.stdout.on("data", (chunk: Buffer) => messageLines.read(chunk))
    child.stderr.on("data", (chunk: Buffer) => logLines.read(chunk))
    for (const emitter of [child, child.stdin, child.stdout, child.stderr])
      emitter.on("error", (error: Error) => context.handleError(error))
    child.on("close", () => context.handleClose())
    return new McpServerProcess(child, groupId, context.processGroups)
  }

  /**
   * Writes one message line to the server.
   *
   * @param message - Message to send.
   * @returns A promise that settles once the line was handed to the pipe,
   * after it drained when it was full.
   * @throws The SDK's `NotConnected` failure once a stop started, or when
   * the pipe closed before or while the line waited for it to drain.
   */
  public send(message: JSONRPCMessage): Promise<void> {
    const input = this.#child.stdin
    if (this.#stopping !== undefined || !input.writable)
      return Promise.reject(createNotConnectedError())
    if (input.write(serializeMessage(message))) return Promise.resolve()
    return waitForDrain(input)
  }

  /**
   * Ends the whole process group, as the class remarks describe.
   *
   * @returns The promise of the first stop, which every later call returns
   * too; it settles once no process of the group is left.
   * @throws When a process of the group is still left
   * {@link MCP_SERVER_STOP_STEP_MILLISECONDS} after `SIGKILL`, such as one
   * the backend may not signal, or `kill` fails for another reason. A group
   * that outlived `SIGKILL` is no longer held: every process of it the
   * backend may signal already received `SIGKILL`, and sending it again at
   * the backend's exit could reach another group that took the identifier
   * once this one ended. A group `kill` failed for stays held, so the
   * backend's exit sends `SIGKILL` to it.
   */
  public stop(): Promise<void> {
    this.#stopping ??= this.#stopGroup()
    return this.#stopping
  }

  /**
   * Closes standard input and signals the group more strongly at each step
   * until no process of it is left.
   *
   * @returns A promise that settles once the group ended.
   * @throws When the group outlived every step, which also stops holding
   * it, or `kill` failed.
   */
  async #stopGroup(): Promise<void> {
    if (this.#child.stdin.writable) this.#child.stdin.end()
    for (const signal of [undefined, "SIGTERM", "SIGKILL"] as const) {
      if (signal !== undefined) sendProcessGroupSignal(this.#groupId, signal)
      const hasEnded = await waitForProcessGroupEnd(
        this.#groupId,
        MCP_SERVER_STOP_STEP_MILLISECONDS
      )
      if (hasEnded) {
        this.#processGroups.remove(this.#groupId)
        return
      }
    }
    this.#processGroups.remove(this.#groupId)
    throw new Error(
      `The MCP server's process group was still running ${MCP_SERVER_STOP_STEP_MILLISECONDS} ms after SIGKILL.`
    )
  }
}

/**
 * Creates the failure of a send to a process that cannot take messages.
 *
 * @returns The SDK's `NotConnected` failure, which its client reports as
 * the connection having closed.
 */
function createNotConnectedError(): SdkError {
  return new SdkError(SdkErrorCode.NotConnected, "Not connected")
}

/**
 * Waits until a full pipe drained, or closed first.
 *
 * @param input - The process's standard input.
 * @returns A promise that settles once the pipe drained.
 * @throws The SDK's `NotConnected` failure when the pipe closed first, such
 * as when the process exited.
 */
function waitForDrain(input: Writable): Promise<void> {
  const draining = Promise.withResolvers<void>()
  const handleDrain = (): void => {
    input.off("close", handleClose)
    draining.resolve()
  }
  const handleClose = (): void => {
    input.off("drain", handleDrain)
    draining.reject(createNotConnectedError())
  }
  input.once("drain", handleDrain)
  input.once("close", handleClose)
  return draining.promise
}
