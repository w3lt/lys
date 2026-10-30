import {
  deserializeMessage,
  type JSONRPCMessage
} from "@modelcontextprotocol/client"
import { MAXIMUM_MCP_RESPONSE_BYTES } from "./mcpResponseLimit"

/** Byte of a line feed, which ends each message line. */
const LINE_FEED = 0x0a

/** Finds the carriage return a Windows-style line ends with. */
const CARRIAGE_RETURN_AT_END = /\r$/u

/** What a stdio server's standard output reports, borrowed by its reader. */
export type McpServerMessageHandlers = Readonly<{
  /** Receives each message the server wrote, in order. */
  handleMessage: (message: JSONRPCMessage) => void
  /** Receives the failure of a line that is not a JSON-RPC message. */
  handleError: (error: Error) => void
  /**
   * Told once, when a line passes {@link MAXIMUM_MCP_RESPONSE_BYTES}; the
   * connection then ends.
   */
  reportLimitPassed: () => void
}>

/**
 * Owns the message line being read from the standard output of one stdio
 * MCP server, to pass on each message once its line is complete.
 *
 * @remarks A line ends at a line feed, and a carriage return before it is
 * dropped. Each line is decoded as UTF-8 and read as one JSON-RPC message,
 * as the SDK's own stdio transport reads it; a line that is not one is
 * passed on as a failure, and reading goes on. A line whose bytes, its line
 * feed included, pass {@link MAXIMUM_MCP_RESPONSE_BYTES} is reported as
 * soon as the bytes read show it, before the line ends; from then on every
 * byte is dropped, so the reader never holds more than the limit while the
 * server goes on writing until its process ends. Concurrency model:
 * single-owner; the stream's `data` events call it on the backend's event
 * loop.
 */
export default class McpServerMessageLines {
  /** Receivers of messages, failures, and the passed limit; borrowed. */
  readonly #handlers: McpServerMessageHandlers
  /** Parts of the line being read, without a line feed. */
  #lineParts: Buffer[]
  /** Bytes of the line being read so far. */
  #lineBytes: number
  /** Whether a line passed the limit, after which every byte is dropped. */
  #hasPassedLimit: boolean

  /**
   * Creates a reader that has read nothing.
   *
   * @param handlers - Receivers of what the server writes; borrowed.
   */
  public constructor(handlers: McpServerMessageHandlers) {
    this.#handlers = handlers
    this.#lineParts = []
    this.#lineBytes = 0
    this.#hasPassedLimit = false
  }

  /**
   * Reads one chunk of the stream and passes on the messages it completes.
   *
   * @param chunk - Bytes the server wrote.
   */
  public read(chunk: Buffer): void {
    let lineStart = 0
    let lineEnd = chunk.indexOf(LINE_FEED, lineStart)
    while (lineEnd !== -1 && this.#addLinePart(chunk, lineStart, lineEnd)) {
      const line = Buffer.concat(this.#lineParts).toString("utf8")
      this.#lineParts = []
      this.#lineBytes = 0
      this.#handleLine(line.replace(CARRIAGE_RETURN_AT_END, ""))
      lineStart = lineEnd + 1
      lineEnd = chunk.indexOf(LINE_FEED, lineStart)
    }
    if (lineEnd === -1) this.#addLinePart(chunk, lineStart, chunk.byteLength)
  }

  /**
   * Adds one part of the line being read, unless the line passes the limit.
   *
   * @param chunk - Bytes the server wrote.
   * @param start - Index of the part's first byte.
   * @param end - Index after the part's last byte.
   * @returns Whether the line, with the line feed that will end it, is
   * still within the limit; false once a line passed it, which is reported
   * the first time.
   */
  #addLinePart(chunk: Buffer, start: number, end: number): boolean {
    if (this.#hasPassedLimit) return false
    this.#lineBytes += end - start
    if (this.#lineBytes + 1 > MAXIMUM_MCP_RESPONSE_BYTES) {
      this.#hasPassedLimit = true
      this.#lineParts = []
      this.#handlers.reportLimitPassed()
      return false
    }
    if (end > start) this.#lineParts.push(chunk.subarray(start, end))
    return true
  }

  /**
   * Passes on the message one complete line holds, or why it holds none.
   *
   * @param line - Line without its line end.
   */
  #handleLine(line: string): void {
    let message: JSONRPCMessage
    try {
      message = deserializeMessage(line)
    } catch (error) {
      this.#handlers.handleError(
        error instanceof Error ? error : new Error(String(error))
      )
      return
    }
    this.#handlers.handleMessage(message)
  }
}
