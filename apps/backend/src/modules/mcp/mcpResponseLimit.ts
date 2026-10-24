import type {
  Transformer,
  TransformStreamDefaultController
} from "node:stream/web"

/**
 * Most bytes the backend reads of one answer of an MCP server, inclusive:
 * one HTTP response body, or one message line a stdio server writes.
 *
 * @remarks Far more than a tool list page or a result the model reads, which
 * is cut to 20,000 characters, while bounding the memory one answer can
 * take, like the limit on vmo's answers. Over HTTP, a body that passes it
 * ends with {@link McpResponseTooLargeError}; over stdio, the SDK ends the
 * connection.
 */
export const MAXIMUM_MCP_RESPONSE_BYTES = 16 * 1024 * 1024

/**
 * Failure of an HTTP answer of an MCP server whose body is longer than
 * {@link MAXIMUM_MCP_RESPONSE_BYTES}; the rest of it is not read.
 *
 * @remarks The subclass preserves the native `Error` contract; its message
 * names the limit, never the answer.
 */
export class McpResponseTooLargeError extends Error {
  /** Creates the failure of one answer over the limit. */
  public constructor() {
    super(
      `The MCP server's answer is longer than ${MAXIMUM_MCP_RESPONSE_BYTES} bytes, the most Lys reads.`
    )
    this.name = "McpResponseTooLargeError"
  }
}

/**
 * Counts the bytes of one response body and fails it once they pass
 * {@link MAXIMUM_MCP_RESPONSE_BYTES}.
 *
 * @remarks Lifecycle: one instance per body, used by one `TransformStream`.
 * Each chunk within the limit is passed on unchanged; the chunk that passes
 * it errors the stream with {@link McpResponseTooLargeError}, which cancels
 * the rest of the body. Concurrency model: single-owner; the stream calls it
 * for one chunk at a time.
 */
class McpResponseByteLimit implements Transformer<Uint8Array, Uint8Array> {
  /** Bytes passed on so far. */
  #readBytes = 0

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
    if (this.#readBytes > MAXIMUM_MCP_RESPONSE_BYTES)
      controller.error(new McpResponseTooLargeError())
    else controller.enqueue(chunk)
  }
}

/**
 * Sends one HTTP request of an MCP transport with Node's `fetch` and limits
 * the body of its answer to {@link MAXIMUM_MCP_RESPONSE_BYTES}.
 *
 * @param url - Endpoint the transport sends to.
 * @param init - The transport's request, with its headers and redirect
 * setting, which are sent as given.
 * @returns The answer with the same status, status text, and headers; its
 * body, when it has one, fails with {@link McpResponseTooLargeError} once it
 * passes the limit, and each body is counted on its own, an event stream
 * included.
 * @throws What `fetch` throws, such as when no connection can be made.
 * @remarks The returned answer has no `url`; the transport then uses its
 * endpoint, which is where every request goes because no redirect is
 * followed.
 */
export async function fetchMcpResponse(
  url: string | URL,
  init?: RequestInit
): Promise<Response> {
  const response = await fetch(url, init)
  if (response.body === null) return response
  return new Response(
    response.body.pipeThrough(new TransformStream(new McpResponseByteLimit())),
    {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    }
  )
}
