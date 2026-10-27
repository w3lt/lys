/**
 * Most characters of one server log line the backend keeps; the rest of a
 * longer line is dropped.
 */
export const MAXIMUM_SERVER_LOG_LINE_LENGTH = 2000

/** Finds each line break, Windows-style ones included. */
const LINE_BREAK_PATTERN = /\r?\n/

/**
 * Owns the line being read from the standard error of one stdio MCP server,
 * to report each line once it is complete.
 *
 * @remarks Each line is reported without its line break, cut to
 * {@link MAXIMUM_SERVER_LOG_LINE_LENGTH} characters; blank lines are left
 * out. A line without a line break yet is held, but never more than the cut
 * length of it: its first part is reported once it reaches that length, and
 * the rest up to the next line break is dropped. Bytes are decoded as UTF-8
 * across chunks. Text held when the stream ends is not reported.
 * Concurrency model: single-owner; the stream's `data` events call it on the
 * backend's event loop.
 */
export default class McpServerLogLines {
  /** Receives each complete line. */
  readonly #reportLine: (line: string) => void
  /** Decodes UTF-8 whose characters may be split across chunks. */
  readonly #decoder: TextDecoder
  /** Text after the last line break, shorter than the cut length. */
  #pendingText: string
  /** Whether the rest of a cut line is being dropped. */
  #isDroppingRest: boolean

  /**
   * Creates a reader that has read nothing.
   *
   * @param reportLine - Receives each complete line.
   */
  public constructor(reportLine: (line: string) => void) {
    this.#reportLine = reportLine
    this.#decoder = new TextDecoder()
    this.#pendingText = ""
    this.#isDroppingRest = false
  }

  /**
   * Reads one chunk of the stream and reports the lines it completes.
   *
   * @param chunk - Bytes the server wrote.
   */
  public read(chunk: Uint8Array): void {
    const text = this.#decoder.decode(chunk, { stream: true })
    const lines = (this.#pendingText + text).split(LINE_BREAK_PATTERN)
    this.#pendingText = lines.pop() ?? ""
    for (const line of lines) {
      if (!this.#isDroppingRest) this.#handleReadLine(line)
      this.#isDroppingRest = false
    }
    if (this.#pendingText.length < MAXIMUM_SERVER_LOG_LINE_LENGTH) return
    if (!this.#isDroppingRest) this.#handleReadLine(this.#pendingText)
    this.#pendingText = ""
    this.#isDroppingRest = true
  }

  /**
   * Reports one line when it holds anything.
   *
   * @param line - Line without its line break.
   */
  #handleReadLine(line: string): void {
    if (line.trim() === "") return
    this.#reportLine(line.slice(0, MAXIMUM_SERVER_LOG_LINE_LENGTH))
  }
}
