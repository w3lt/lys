/**
 * Loopback HTTP and TCP observation for the verification harness.
 *
 * @remarks Every request has a time-out. Server-sent events are read with
 * the arrival time of each event, so a journey can prove that a reply
 * streamed instead of arriving as one block.
 */

import { connect } from "node:net"

/** Default time-out of one JSON request, in milliseconds. */
const REQUEST_TIMEOUT_MS = 10_000

/** Default time-out of one whole event stream, in milliseconds. */
const STREAM_TIMEOUT_MS = 60_000

/**
 * Reports whether something accepts TCP connections on a loopback port.
 *
 * @param {number} port - TCP port on `127.0.0.1`.
 * @returns {Promise<boolean>} A promise that resolves to `true` when a
 * connection succeeds.
 */
export function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port })
    socket.once("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.once("error", () => resolve(false))
  })
}

/**
 * Result of {@link sendJsonRequest}.
 *
 * @typedef {object} JsonExchange
 * @property {number} status - HTTP status code.
 * @property {unknown} body - Parsed JSON body, or the raw text when the body
 * is not JSON.
 */

/**
 * Options of {@link sendJsonRequest} and {@link readServerSentEvents}.
 *
 * @typedef {object} JsonRequestOptions
 * @property {string} [method] - HTTP method. Defaults to `GET`.
 * @property {unknown} [json] - Body to send as JSON. Omitted for a body-less
 * request.
 * @property {Readonly<Record<string, string>>} [headers] - Extra headers
 * merged over the JSON headers.
 * @property {number} [timeoutMs] - Deadline in milliseconds. Defaults to 10
 * seconds for a request and 60 seconds for a stream.
 */

/**
 * Sends one request and reads its whole answer.
 *
 * @param {string} url - Absolute URL.
 * @param {JsonRequestOptions} [options] - Method, JSON body, headers, and
 * deadline.
 * @returns {Promise<JsonExchange>} The status and parsed body; a non-JSON
 * body is returned as text.
 * @throws If the connection fails or the deadline passes.
 */
export async function sendJsonRequest(url, options = {}) {
  const response = await fetch(
    url,
    buildRequestInit(options, "application/json", REQUEST_TIMEOUT_MS)
  )
  const text = await response.text()
  return Object.freeze({ status: response.status, body: parseJsonText(text) })
}

/**
 * One server-sent event with the time it was parsed.
 *
 * @typedef {object} TimedServerSentEvent
 * @property {number} atMs - Milliseconds since the stream was opened.
 * @property {string | undefined} event - The event's `event` field, when the
 * server sent one.
 * @property {unknown} data - The parsed `data` field; raw text when it is
 * not JSON.
 */

/**
 * Opens a server-sent event stream and yields each event as it arrives.
 *
 * @param {string} url - Absolute URL of the stream.
 * @param {JsonRequestOptions} [options] - Method, JSON body, headers, and a
 * deadline for the whole stream.
 * @returns {AsyncGenerator<TimedServerSentEvent>} An async generator of
 * events that ends when the server closes the stream; abandoning the
 * generator closes the connection.
 * @throws If the server answers with a non-2xx status, with the status and
 * body text in the message.
 */
export async function* readServerSentEvents(url, options = {}) {
  const openedAt = performance.now()
  const response = await fetch(
    url,
    buildRequestInit(options, "text/event-stream", STREAM_TIMEOUT_MS)
  )
  if (!response.ok || response.body === null) {
    throw new Error(
      `Event stream request failed with HTTP ${response.status}: ${await response.text()}`
    )
  }
  const decoder = new TextDecoder()
  let buffered = ""
  for await (const chunk of response.body) {
    buffered += decoder.decode(chunk, { stream: true })
    const blocks = buffered.split("\n\n")
    buffered = blocks.pop() ?? ""
    for (const block of blocks) {
      const event = parseEventBlock(block, performance.now() - openedAt)
      if (event !== undefined) yield event
    }
  }
}

/**
 * Builds the `fetch` options of one request.
 *
 * @param {JsonRequestOptions} options - Caller options.
 * @param {string} accept - Media type the caller accepts.
 * @param {number} defaultTimeoutMs - Deadline when the caller names none.
 * @returns {RequestInit} The method, headers, body, and abort signal.
 */
function buildRequestInit(options, accept, defaultTimeoutMs) {
  const hasBody = options.json !== undefined
  return {
    method: options.method ?? "GET",
    headers: {
      accept,
      ...(hasBody ? { "content-type": "application/json" } : {}),
      ...(options.headers ?? {})
    },
    body: hasBody ? JSON.stringify(options.json) : undefined,
    signal: AbortSignal.timeout(options.timeoutMs ?? defaultTimeoutMs)
  }
}

/**
 * Parses one blank-line-delimited event block.
 *
 * @param {string} block - The block's lines, without the trailing blank line.
 * @param {number} atMs - Arrival time relative to the stream's opening.
 * @returns {TimedServerSentEvent | undefined} The event, or `undefined` for
 * a comment or keep-alive block.
 */
function parseEventBlock(block, atMs) {
  const fields = block
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith(":"))
    .map(parseEventField)
  const dataLines = fields
    .filter((field) => field.name === "data")
    .map((field) => field.value)
  if (dataLines.length === 0) return undefined
  const eventName = fields.find((field) => field.name === "event")?.value
  return Object.freeze({
    atMs: Math.round(atMs),
    event: eventName,
    data: parseJsonText(dataLines.join("\n"))
  })
}

/**
 * Splits one `name: value` event line.
 *
 * @param {string} line - A non-empty, non-comment line.
 * @returns {{name: string, value: string}} The field name and its value with
 * one leading space removed.
 */
function parseEventField(line) {
  const separator = line.indexOf(":")
  if (separator === -1) return { name: line, value: "" }
  const value = line.slice(separator + 1)
  return {
    name: line.slice(0, separator),
    value: value.startsWith(" ") ? value.slice(1) : value
  }
}

/**
 * Parses text as JSON when it is JSON.
 *
 * @param {string} text - Response or event text.
 * @returns {unknown} The parsed value, or the text itself when it is not
 * JSON.
 */
export function parseJsonText(text) {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
