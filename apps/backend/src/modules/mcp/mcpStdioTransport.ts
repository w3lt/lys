import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/client"
import type { StdioClientTransport } from "@modelcontextprotocol/client/stdio"

/**
 * Owns the SDK's stdio transport of one MCP server, so that every close of
 * it waits for the same end of its process.
 *
 * @remarks The SDK's transport forgets its process as soon as a close
 * starts, so a second close, such as the one Lys makes after the SDK closed
 * a failed handshake without waiting, returned at once while the first was
 * still stopping the process. Here the first close is shared by every later
 * one: it settles once the process exited after its standard input closed,
 * or after `SIGTERM` two seconds later, or once `SIGKILL` was sent two
 * seconds after that, without waiting for the killed process to exit. The
 * close the SDK transport starts by itself, after a standard-output line
 * passed the response limit, does not go through here, so a later close
 * does not wait for that one. The callbacks the client installs are told
 * what the SDK transport reports, from {@link start} on. Resource
 * ownership: owns the SDK transport and the process it starts. Concurrency
 * model: single-owner; the SDK client that connects it is its only user.
 */
export default class McpStdioTransport implements Transport {
  /** The SDK's transport, which starts and ends the process; owned. */
  readonly #transport: StdioClientTransport
  /** Completion of the first close, shared by every later close. */
  #closing: Promise<void> | undefined
  /** Told when the process has closed; installed by the client. */
  #onclose: Transport["onclose"]
  /** Told of a failure outside any request; installed by the client. */
  #onerror: Transport["onerror"]
  /** Told of each message the server writes; installed by the client. */
  #onmessage: Transport["onmessage"]

  /**
   * Takes ownership of a transport that has not started.
   *
   * @param transport - The SDK's stdio transport, not started; owned from
   * here on.
   */
  public constructor(transport: StdioClientTransport) {
    this.#transport = transport
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
   * @param callback - Told when the process has closed.
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
   * Implements {@link Transport.start} by starting the process, whose
   * events reach the installed callbacks from here on.
   *
   * @returns A promise that settles once the process started.
   * @throws The spawn failure when the command cannot start.
   */
  public start(): Promise<void> {
    this.#transport.onclose = () => {
      this.#onclose?.()
    }
    this.#transport.onerror = (error) => {
      this.#onerror?.(error)
    }
    this.#transport.onmessage = (message: JSONRPCMessage) => {
      this.#onmessage?.(message)
    }
    return this.#transport.start()
  }

  /**
   * Implements {@link Transport.send} by writing one message line to the
   * process.
   *
   * @param message - Message to send.
   * @returns A promise that settles once the line was written.
   * @throws The SDK's `NotConnected` failure once the process is gone.
   */
  public send(message: JSONRPCMessage): Promise<void> {
    return this.#transport.send(message)
  }

  /**
   * Implements {@link Transport.close} by ending the process once.
   *
   * @returns The promise of the first close, which every later call returns
   * too; see the class remarks for when it settles.
   */
  public close(): Promise<void> {
    this.#closing ??= this.#transport.close()
    return this.#closing
  }
}
