import type {
  Transformer,
  TransformStreamDefaultController
} from "node:stream/web"

/**
 * Most bytes the backend reads of one answer of an MCP server, inclusive:
 * one HTTP response body, one event of an event stream, or one message line
 * a stdio server writes.
 *
 * @remarks Far more than a tool list page or a result the model reads, which
 * is cut to 20,000 characters, while bounding the memory one answer can
 * take, like the limit on vmo's answers. An answer that passes it ends the
 * connection, over either transport: over HTTP, {@link sendMcpHttpRequest}
 * reports it and fails the body with {@link McpResponseTooLargeError}; over
 * stdio, the SDK ends the connection itself.
 */
export const MAXIMUM_MCP_RESPONSE_BYTES = 16 * 1024 * 1024

/**
 * Failure of an HTTP answer of an MCP server whose body, or one event of
 * whose event stream, is longer than {@link MAXIMUM_MCP_RESPONSE_BYTES}, the
 * rest of which is not read, and of every request of the connection that
 * answer ended.
 *
 * @remarks The subclass preserves the native `Error` contract; its message
 * names the limit, never the answer. A request's failure carries the SDK's
 * own failure of that request, such as the closed connection, as its cause.
 */
export class McpResponseTooLargeError extends Error {
  /**
   * Creates the failure of one answer over the limit.
   *
   * @param options - The SDK's failure of a request, as `cause`, when the
   * request failed because its connection ended at an answer over the
   * limit.
   */
  public constructor(options?: ErrorOptions) {
    super(
      `The MCP server's answer is longer than ${MAXIMUM_MCP_RESPONSE_BYTES} bytes, the most Lys reads.`,
      options
    )
    this.name = "McpResponseTooLargeError"
  }
}

/** Status of an answer that accepts a message and sends no reply to it. */
const ACCEPTED_STATUS = 202

/** Media type of an event stream, which the SDK reads one event at a time. */
const EVENT_STREAM_MEDIA_TYPE = "text/event-stream"

/** Byte of a carriage return, which ends a line of an event stream. */
const CARRIAGE_RETURN = 0x0d

/**
 * Byte of a line feed, which ends a line of an event stream unless it
 * follows a carriage return, with which it ends one line.
 */
const LINE_FEED = 0x0a

/**
 * Counts the bytes of one response body and fails it once they pass
 * {@link MAXIMUM_MCP_RESPONSE_BYTES}.
 *
 * @remarks Lifecycle: one instance per body, used by one `TransformStream`.
 * Each chunk within the limit is passed on unchanged; the chunk that passes
 * it is reported first, then errors the stream with
 * {@link McpResponseTooLargeError}, which cancels the rest of the body.
 * Concurrency model: single-owner; the stream calls it for one chunk at a
 * time.
 */
class McpResponseByteLimit implements Transformer<Uint8Array, Uint8Array> {
  /** Told once the body passes the limit; borrowed from the connection. */
  readonly #reportLimitPassed: () => void
  /** Bytes passed on so far. */
  #readBytes = 0

  /**
   * Creates a counter that has read nothing.
   *
   * @param reportLimitPassed - Told when the body passes the limit, before
   * it fails; borrowed.
   */
  public constructor(reportLimitPassed: () => void) {
    this.#reportLimitPassed = reportLimitPassed
  }

  /**
   * Passes on one chunk, or fails the body once it passes the limit.
   *
   * @param chunk - Bytes the server sent.
   * @param controller - Controller of the limited body.
   */
  public transform(
    chunk: Uint8Array,
    controller: TransformStreamDefaultController<Uint8Array>
  ): void {
    this.#readBytes += chunk.byteLength
    if (this.#readBytes <= MAXIMUM_MCP_RESPONSE_BYTES) {
      controller.enqueue(chunk)
      return
    }
    this.#reportLimitPassed()
    controller.error(new McpResponseTooLargeError())
  }
}

/**
 * Counts the bytes of each event of one event stream and fails the stream
 * once one event passes {@link MAXIMUM_MCP_RESPONSE_BYTES}.
 *
 * @remarks Lifecycle: one instance per body, used by one `TransformStream`.
 * An event ends at a blank line; a line ends at a carriage return, a line
 * feed, or both in that order, even when a chunk ends between them. An
 * event counts its lines with their line ends, not the blank line, and the
 * count starts again after each blank line, so a stream that stays open,
 * such as the one the SDK opens for the server's own messages, can send
 * any number of events within the limit; the SDK holds one event at a
 * time. A chunk within the limit is passed on unchanged; the chunk in which
 * an event passes it is reported first, then errors the stream with
 * {@link McpResponseTooLargeError}, which cancels the rest of the body.
 * Concurrency model: single-owner; the stream calls it for one chunk at a
 * time.
 */
class McpEventByteLimit implements Transformer<Uint8Array, Uint8Array> {
  /** Told once an event passes the limit; borrowed from the connection. */
  readonly #reportLimitPassed: () => void
  /** Bytes of the event being read, after the blank line before it. */
  #eventBytes = 0
  /** Whether the line being read has no byte but its line end yet. */
  #isLineEmpty = true
  /** Whether the byte read before was a carriage return. */
  #followsCarriageReturn = false

  /**
   * Creates a counter that has read nothing.
   *
   * @param reportLimitPassed - Told when an event passes the limit, before
   * the stream fails; borrowed.
   */
  public constructor(reportLimitPassed: () => void) {
    this.#reportLimitPassed = reportLimitPassed
  }

  /**
   * Passes on one chunk, or fails the stream once an event in it passes
   * the limit.
   *
   * @param chunk - Bytes the server sent.
   * @param controller - Controller of the limited stream.
   */
  public transform(
    chunk: Uint8Array,
    controller: TransformStreamDefaultController<Uint8Array>
  ): void {
    for (const byte of chunk) {
      this.#readEventByte(byte)
      if (this.#eventBytes > MAXIMUM_MCP_RESPONSE_BYTES) {
        this.#reportLimitPassed()
        controller.error(new McpResponseTooLargeError())
        return
      }
    }
    controller.enqueue(chunk)
  }

  /**
   * Counts one byte toward the event being read, which counts every byte of
   * its lines with their line ends and none of the blank line that ends it,
   * after which the count starts again.
   *
   * @param byte - Next byte of the stream.
   */
  #readEventByte(byte: number): void {
    const followsCarriageReturn = this.#followsCarriageReturn
    this.#followsCarriageReturn = byte === CARRIAGE_RETURN
    if (byte === LINE_FEED && followsCarriageReturn) {
      if (this.#eventBytes > 0) this.#eventBytes += 1
      return
    }
    this.#eventBytes += 1
    if (byte !== CARRIAGE_RETURN && byte !== LINE_FEED) {
      this.#isLineEmpty = false
      return
    }
    if (this.#isLineEmpty) this.#eventBytes = 0
    this.#isLineEmpty = true
  }
}

/**
 * Answers whether the SDK may read an answer as an event stream, one event
 * at a time.
 *
 * @param response - The server's answer.
 * @returns Whether it is a success other than 202 whose `Content-Type` names
 * only the media type `text/event-stream`, in any case and with any
 * parameters. The SDK reads every other answer it reads at all as one whole
 * text or JSON value, so counting such an answer per event would not bound
 * what it holds.
 * @remarks An answer to the SDK's GET of another media type, which the SDK
 * also reads as an event stream, is counted whole: stricter than needed,
 * never looser. The media type is read as the SDK reads it, and an answer
 * naming two, which the SDK refuses, is counted whole too.
 */
function isEventStreamAnswer(response: Response): boolean {
  if (!response.ok || response.status === ACCEPTED_STATUS) return false
  const contentType = response.headers.get("content-type")
  if (contentType === null || contentType.includes(",")) return false
  const mediaType = contentType.split(";", 1)[0] ?? ""
  return mediaType.trim().toLowerCase() === EVENT_STREAM_MEDIA_TYPE
}

/**
 * Sends one HTTP request of an MCP transport with Node's `fetch` and limits
 * the body of its answer to {@link MAXIMUM_MCP_RESPONSE_BYTES}.
 *
 * @param url - Endpoint the transport sends to.
 * @param init - The transport's request, with its headers and redirect
 * setting, which are sent as given.
 * @param reportLimitPassed - Told when the body passes the limit, before it
 * fails, so the connection can end; borrowed.
 * @returns The answer with the same status, status text, and headers; its
 * body, when it has one, fails with {@link McpResponseTooLargeError} once it
 * passes the limit. Each body is counted on its own, and an event stream the
 * SDK reads one event at a time is counted per event instead.
 * @throws What `fetch` throws, such as when no connection can be made.
 * @remarks The returned answer has no `url`; the transport then uses its
 * endpoint, which is where every request goes because no redirect is
 * followed. The SDK fails a request whose event stream breaks only for some
 * requests, so the limit is reported for the connection to end, which fails
 * every request it has in flight.
 */
export async function sendMcpHttpRequest(
  url: string | URL,
  init: RequestInit | undefined,
  reportLimitPassed: () => void
): Promise<Response> {
  const response = await fetch(url, init)
  if (response.body === null) return response
  const limit = isEventStreamAnswer(response)
    ? new McpEventByteLimit(reportLimitPassed)
    : new McpResponseByteLimit(reportLimitPassed)
  return new Response(response.body.pipeThrough(new TransformStream(limit)), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  })
}
