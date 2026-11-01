import {
  SdkHttpError,
  type JSONRPCMessage,
  type StreamableHTTPClientTransport,
  type Transport
} from "@modelcontextprotocol/client"
import { AsyncLocalStorage } from "node:async_hooks"

/** Options of one message as the SDK's Streamable HTTP transport takes them. */
type HttpSendOptions = NonNullable<
  Parameters<StreamableHTTPClientTransport["send"]>[1]
>

/**
 * One send of the transport, while the failures the SDK reports during it
 * wait to be compared with its own failure.
 *
 * @remarks Mutable on purpose: the send marks itself settled, and the
 * failures reported while it was pending are held here until then.
 */
type PendingSend = {
  /** Whether the send has settled. */
  isSettled: boolean
  /** Failures the SDK reported while the send was pending, in order. */
  readonly heldErrors: Error[]
}

/**
 * Owns the SDK's Streamable HTTP transport of one MCP server, so that each
 * failure reaches the log once and without the body of an HTTP error
 * answer.
 *
 * @remarks The SDK's transport reports a failed send through `onerror` and
 * then rejects the send with the same error, which the request it carried
 * also rejects with; here such a failure is passed on only by the send's
 * rejection. A failure the SDK reports during a send that the send does not
 * reject with, or after it, such as a broken event stream, is passed on
 * through `onerror`, once even when the SDK reports the same error twice. A
 * failed send rejects with an `SdkHttpError` of the same code and status
 * whose message is Lys's fixed text and which keeps no body, because the
 * SDK writes the error into the message of a failure it reports later, such
 * as a cancellation it could not send. Only what the SDK's `legacy`-era
 * client uses is offered: the callbacks, which are told what the SDK
 * transport reports from {@link start} on, the session identifier, and the
 * protocol version. Resource ownership: owns the SDK transport, whose
 * requests close ends. Concurrency model: single-owner; the SDK client that
 * connects it is its only user, while its sends may overlap.
 */
export default class McpHttpTransport implements Transport {
  /** The SDK's transport, which sends every request; owned. */
  readonly #transport: StreamableHTTPClientTransport
  /** The send each failure the SDK reports runs within, if any. */
  readonly #sends: AsyncLocalStorage<PendingSend>
  /** Failures already passed on, so one reported twice is passed on once. */
  readonly #reportedErrors: WeakSet<Error>
  /** Told when the transport closes; installed by the client. */
  #onclose: Transport["onclose"]
  /** Told of a failure outside any request; installed by the client. */
  #onerror: Transport["onerror"]
  /** Told of each message the server sends; installed by the client. */
  #onmessage: Transport["onmessage"]

  /**
   * Takes ownership of a transport that has not started.
   *
   * @param transport - The SDK's Streamable HTTP transport, not started;
   * owned from here on.
   */
  public constructor(transport: StreamableHTTPClientTransport) {
    this.#transport = transport
    this.#sends = new AsyncLocalStorage()
    this.#reportedErrors = new WeakSet()
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
   * @param callback - Told when the transport closes.
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
   * Implements {@link Transport.onerror}; see the class remarks for which
   * failures it is told.
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
   * @param callback - Told of each message the server sends.
   */
  public set onmessage(callback: Transport["onmessage"]) {
    this.#onmessage = callback
  }

  /**
   * Implements {@link Transport.sessionId}.
   *
   * @returns The session the server started at the handshake, if any.
   */
  public get sessionId(): string | undefined {
    return this.#transport.sessionId
  }

  /**
   * Implements {@link Transport.setProtocolVersion}.
   *
   * @param version - Protocol version the handshake settled on, sent with
   * every later request.
   */
  public setProtocolVersion(version: string): void {
    this.#transport.setProtocolVersion(version)
  }

  /**
   * Implements {@link Transport.start}; from here on, what the SDK transport
   * reports reaches the installed callbacks, its failures as the class
   * remarks say.
   *
   * @returns A promise that settles once the transport can send.
   */
  public start(): Promise<void> {
    this.#transport.onclose = () => {
      this.#onclose?.()
    }
    this.#transport.onerror = (error) => {
      this.#handleTransportError(error)
    }
    this.#transport.onmessage = (message: JSONRPCMessage) => {
      this.#onmessage?.(message)
    }
    return this.#transport.start()
  }

  /**
   * Implements {@link Transport.send} by sending one message as an HTTP
   * request.
   *
   * @param message - Message to send.
   * @param options - The SDK's options of the message, such as its own
   * abort signal.
   * @returns A promise that settles once the server's answer was accepted;
   * an answer that is an event stream goes on being read after that.
   * @throws The SDK transport's failure, such as a failed connection; an
   * HTTP error answer as an `SdkHttpError` with the same code and status
   * and without the answer's body.
   */
  public async send(
    message: JSONRPCMessage,
    options?: HttpSendOptions
  ): Promise<void> {
    const send: PendingSend = { isSettled: false, heldErrors: [] }
    try {
      await this.#sends.run(send, () => this.#transport.send(message, options))
    } catch (error) {
      this.#handleSendEnd(send, error)
      throw buildBodyFreeFailure(error)
    }
    this.#handleSendEnd(send, undefined)
  }

  /**
   * Implements {@link Transport.close} by aborting every request in flight.
   *
   * @returns A promise that settles once the requests were aborted; the
   * server is not asked to end its session here, but by the connection
   * once this close settled.
   */
  public close(): Promise<void> {
    return this.#transport.close()
  }

  /**
   * Holds a failure the SDK reports during a pending send until the send
   * settles, or passes it on.
   *
   * @param error - Failure the SDK transport reported.
   */
  #handleTransportError(error: Error): void {
    const send = this.#sends.getStore()
    if (send === undefined || send.isSettled) this.#sendErrorToClient(error)
    else send.heldErrors.push(error)
  }

  /**
   * Marks a send settled and passes on the failures it held, except the one
   * it rejects with.
   *
   * @param send - The send that settled.
   * @param failure - What the send rejected with; undefined when it
   * fulfilled.
   */
  #handleSendEnd(send: PendingSend, failure: unknown): void {
    send.isSettled = true
    send.heldErrors
      .filter((error) => error !== failure)
      .forEach((error) => this.#sendErrorToClient(error))
  }

  /**
   * Passes one failure on to the client, unless it was passed on before.
   *
   * @param error - Failure the SDK transport reported.
   */
  #sendErrorToClient(error: Error): void {
    if (this.#reportedErrors.has(error)) return
    this.#reportedErrors.add(error)
    this.#onerror?.(error)
  }
}

/**
 * Builds the failure a send rejects with.
 *
 * @param error - What the SDK transport's send rejected with.
 * @returns For an HTTP error answer, an `SdkHttpError` with its code and
 * status, Lys's fixed message, and neither the answer's body nor its cause;
 * any other failure unchanged.
 */
function buildBodyFreeFailure(error: unknown): unknown {
  if (!(error instanceof SdkHttpError)) return error
  return new SdkHttpError(
    error.code,
    `The MCP server answered with HTTP status ${error.status}.`,
    { status: error.status }
  )
}
