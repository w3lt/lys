import {
  SdkError,
  SdkErrorCode,
  type JSONRPCMessage,
  type Transport
} from "@modelcontextprotocol/client"
import type McpServerProcess from "./mcpServerProcess"
import type { McpServerProcessHandlers } from "./mcpServerProcess"

/** What the transport uses of a started server's process. */
export type McpStdioServerProcess = Pick<McpServerProcess, "send" | "stop">

/**
 * Starts one server's process whose output reaches the given handlers.
 *
 * @param handlers - Receivers of what the process reports.
 * @returns The started process, which the caller owns.
 * @throws Node's failure to start the command.
 */
export type McpServerProcessStarter = (
  handlers: McpServerProcessHandlers
) => Promise<McpStdioServerProcess>

/**
 * Owns the process group of one stdio MCP server for the SDK's client, so
 * that every close of the connection waits for the same end of the whole
 * group.
 *
 * @remarks {@link start} starts the server's command in a process group of
 * its own through a {@link McpServerProcess}. The first close is shared by
 * every later one, whoever starts it: the client, the connection after a
 * message line passed the response limit, or the transport itself once the
 * command's process closed by itself, which ends the rest of its group too.
 * It settles once no process of the group is left, as
 * {@link McpServerProcess.stop} describes, or once that stop gave up, and
 * only then tells the client that the transport closed, so the client never
 * forgets a transport whose processes it still stops. The callbacks the client installs are told what the
 * process reports, from {@link start} on. Resource ownership: owns the
 * process it starts. Concurrency model: single-owner; the SDK client that
 * connects it is its only user, while the process reports on the backend's
 * event loop.
 */
export default class McpStdioTransport implements Transport {
  /** Starts the server's process; borrowed from the connection. */
  readonly #startProcess: McpServerProcessStarter
  /** The start of the process, once {@link start} ran. */
  #starting: Promise<McpStdioServerProcess> | undefined
  /** Completion of the first close, shared by every later close. */
  #closing: Promise<void> | undefined
  /** Told when the transport has closed; installed by the client. */
  #onclose: Transport["onclose"]
  /** Told of a failure outside any request; installed by the client. */
  #onerror: Transport["onerror"]
  /** Told of each message the server writes; installed by the client. */
  #onmessage: Transport["onmessage"]

  /**
   * Creates a transport that has started nothing.
   *
   * @param startProcess - Starts the server's process; borrowed.
   */
  public constructor(startProcess: McpServerProcessStarter) {
    this.#startProcess = startProcess
    this.#starting = undefined
    this.#closing = undefined
    this.#onclose = undefined
    this.#onerror = undefined
    this.#onmessage = undefined
  }

  /**
   * Implements {@link Transport.onclose}.
   *
   * @returns The callback the client installed, if any.
   */
  public get onclose(): Transport["onclose"] {
    return this.#onclose
  }

  /**
   * Implements {@link Transport.onclose}.
   *
   * @param callback - Told once the transport has closed.
   */
  public set onclose(callback: Transport["onclose"]) {
    this.#onclose = callback
  }

  /**
   * Implements {@link Transport.onerror}.
   *
   * @returns The callback the client installed, if any.
   */
  public get onerror(): Transport["onerror"] {
    return this.#onerror
  }

  /**
   * Implements {@link Transport.onerror}.
   *
   * @param callback - Told of a failure outside any request.
   */
  public set onerror(callback: Transport["onerror"]) {
    this.#onerror = callback
  }

  /**
   * Implements {@link Transport.onmessage}.
   *
   * @returns The callback the client installed, if any.
   */
  public get onmessage(): Transport["onmessage"] {
    return this.#onmessage
  }

  /**
   * Implements {@link Transport.onmessage}.
   *
   * @param callback - Told of each message the server writes.
   */
  public set onmessage(callback: Transport["onmessage"]) {
    this.#onmessage = callback
  }

  /**
   * Implements {@link Transport.start} by starting the server's process,
   * whose reports reach the installed callbacks from here on.
   *
   * @returns A promise that settles once the process started.
   * @throws Node's failure to start the command, such as `spawn npx ENOENT`;
   * the transport can still be closed then, which ends nothing.
   */
  public async start(): Promise<void> {
    this.#starting = this.#startProcess({
      handleMessage: (message) => this.#onmessage?.(message),
      handleError: (error) => this.#onerror?.(error),
      handleClose: () => {
        this.close().catch((error: unknown) => this.#reportCloseFailure(error))
      }
    })
    await this.#starting
  }

  /**
   * Implements {@link Transport.send} by writing one message line to the
   * process.
   *
   * @param message - Message to send.
   * @returns A promise that settles once the line was written.
   * @throws The SDK's `NotConnected` failure before the process started,
   * once a close started, or once the process is gone.
   */
  public async send(message: JSONRPCMessage): Promise<void> {
    if (this.#starting === undefined || this.#closing !== undefined)
      throw new SdkError(SdkErrorCode.NotConnected, "Not connected")
    const serverProcess = await this.#starting
    await serverProcess.send(message)
  }

  /**
   * Implements {@link Transport.close} by ending the process group once.
   *
   * @returns The promise of the first close, which every later call returns
   * too; see the class remarks for when it settles.
   * @throws What {@link McpServerProcess.stop} throws when the group
   * outlived `SIGKILL`; the client is told the transport closed all the
   * same.
   */
  public close(): Promise<void> {
    this.#closing ??= this.#closeProcess()
    return this.#closing
  }

  /**
   * Reports a close the transport started itself that failed, which no
   * caller observes.
   *
   * @param error - Why the process group could not be ended.
   */
  #reportCloseFailure(error: unknown): void {
    this.#onerror?.(
      error instanceof Error
        ? error
        : new Error("The MCP server's process could not be ended.", {
            cause: error
          })
    )
  }

  /**
   * Waits for the process to start, if it was being started, ends its
   * group, and tells the client the transport closed. A start that failed
   * started nothing, and its failure reached the client through
   * {@link start}.
   *
   * @returns A promise that settles once the group ended.
   * @throws What stopping the group threw; the client is told the transport
   * closed then too.
   */
  async #closeProcess(): Promise<void> {
    try {
      const serverProcess = await this.#starting?.catch(() => undefined)
      await serverProcess?.stop()
    } finally {
      this.#onclose?.()
    }
  }
}
