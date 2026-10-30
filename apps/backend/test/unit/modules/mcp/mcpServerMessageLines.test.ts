import type { JSONRPCMessage } from "@modelcontextprotocol/client"
import { describe, expect, it } from "vitest"
import McpServerMessageLines from "../../../../src/modules/mcp/mcpServerMessageLines"
import { MAXIMUM_MCP_RESPONSE_BYTES } from "../../../../src/modules/mcp/mcpResponseLimit"

/** What a reader passed on, in order. */
type ReadOutcome = {
  /** Messages passed on. */
  readonly messages: JSONRPCMessage[]
  /** Failures passed on. */
  readonly errors: Error[]
  /** How often the limit was reported. */
  limitReports: number
}

/** A notification whose line is short. */
const PING = Object.freeze({ jsonrpc: "2.0", method: "notifications/ping" })

/**
 * Reads chunks in order and collects what the reader passes on.
 *
 * @param chunks - Text or bytes of each chunk, in arrival order.
 * @returns The messages, failures, and limit reports.
 */
function readChunks(chunks: readonly (string | Buffer)[]): ReadOutcome {
  const outcome: ReadOutcome = { messages: [], errors: [], limitReports: 0 }
  const reader = new McpServerMessageLines({
    handleMessage: (message) => outcome.messages.push(message),
    handleError: (error) => outcome.errors.push(error),
    reportLimitPassed: () => {
      outcome.limitReports += 1
    }
  })
  for (const chunk of chunks)
    reader.read(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk)
  return outcome
}

/**
 * Builds a message line, its line feed included, of an exact byte length.
 *
 * @param lineBytes - Bytes of the whole line.
 * @returns The line.
 */
function buildLineOf(lineBytes: number): string {
  const empty = JSON.stringify({ ...PING, params: { text: "" } })
  const text = "x".repeat(lineBytes - Buffer.byteLength(empty) - 1)
  return `${JSON.stringify({ ...PING, params: { text } })}\n`
}

describe("McpServerMessageLines", () => {
  it("passes on each message of one chunk in order", () => {
    const outcome = readChunks([
      `${JSON.stringify(PING)}\n${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })}\n`
    ])

    expect(outcome.messages).toEqual([
      PING,
      { jsonrpc: "2.0", id: 1, result: {} }
    ])
    expect(outcome.errors).toEqual([])
  })

  it("joins a line split across chunks and drops a carriage return before its line feed", () => {
    const line = JSON.stringify(PING)

    const outcome = readChunks([line.slice(0, 5), line.slice(5), "\r\n"])

    expect(outcome.messages).toEqual([PING])
  })

  it("does not pass on text after the last line feed", () => {
    expect(readChunks([JSON.stringify(PING)]).messages).toEqual([])
  })

  it("passes on a line that is not JSON as a failure and goes on reading", () => {
    const outcome = readChunks([`not json\n${JSON.stringify(PING)}\n`])

    expect(outcome.errors).toHaveLength(1)
    expect(outcome.messages).toEqual([PING])
  })

  it("passes on a line as long as the limit, its line feed included", () => {
    const outcome = readChunks([buildLineOf(MAXIMUM_MCP_RESPONSE_BYTES)])

    expect(outcome.messages).toHaveLength(1)
    expect(outcome.limitReports).toBe(0)
  })

  it("reports a line longer than the limit once, before it ends, and drops every later byte", () => {
    const line = buildLineOf(MAXIMUM_MCP_RESPONSE_BYTES + 1)
    const withoutLineEnd = line.slice(0, -1)

    const outcome = readChunks([
      withoutLineEnd,
      `\n${JSON.stringify(PING)}\n`,
      `${JSON.stringify(PING)}\n`
    ])

    expect(outcome.limitReports).toBe(1)
    expect(outcome.messages).toEqual([])
    expect(outcome.errors).toEqual([])
  })

  it("counts a line's bytes across chunks against the limit", () => {
    const half = "x".repeat(MAXIMUM_MCP_RESPONSE_BYTES / 2)

    const outcome = readChunks([half, half])

    expect(outcome.limitReports).toBe(1)
  })

  it("counts each line on its own", () => {
    const line = buildLineOf(MAXIMUM_MCP_RESPONSE_BYTES)

    const outcome = readChunks([line, line])

    expect(outcome.messages).toHaveLength(2)
    expect(outcome.limitReports).toBe(0)
  })
})
