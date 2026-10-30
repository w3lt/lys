import { describe, expect, it, vi } from "vitest"
import {
  sendMcpHttpRequest,
  MAXIMUM_MCP_RESPONSE_BYTES,
  McpResponseTooLargeError
} from "../../../../src/modules/mcp/mcpResponseLimit"

/** Endpoint the stubbed `fetch` is asked for; nothing is sent to it. */
const UNUSED_ENDPOINT = "http://127.0.0.1:9/mcp"

/** Media type of an event stream, as a server names it. */
const EVENT_STREAM_TYPE = "text/event-stream"

/** Bytes of one event's data line, so that two events pass the limit together. */
const HALF_LIMIT_DATA_BYTES = MAXIMUM_MCP_RESPONSE_BYTES / 2 + 1

/** Line ends of an event stream, each with a label for a test name. */
const LINE_END_CASES = [
  ["line feeds", "\n"],
  ["carriage returns and line feeds", "\r\n"],
  ["carriage returns", "\r"]
] as const

/** One answer the stubbed `fetch` returns. */
type ScriptedAnswer = Readonly<{
  /** HTTP status. */
  status: number
  /** `Content-Type` header, if any. */
  contentType: string | undefined
  /** Body, in the chunks the server sends. */
  chunks: readonly string[]
}>

/** What reading the limited body ended with. */
type BodyReading = Readonly<{
  /** Bytes read before the body ended or failed. */
  readBytes: number
  /** What the body failed with, or undefined when it ended. */
  error: unknown
  /** How often the limit was reported passed. */
  reportCount: number
}>

/**
 * Builds a data line of an event stream.
 *
 * @param dataBytes - Bytes of the data after `data: `.
 * @returns The line, without its line end.
 */
function buildDataLine(dataBytes: number): string {
  return `data: ${"x".repeat(dataBytes)}`
}

/**
 * Builds one event of an event stream, ended by its blank line.
 *
 * @param eventBytes - Bytes of its one data line with that line's end, at
 * least 6 plus the line end's length.
 * @param lineEnd - Line end of both its data line and its blank line.
 * @returns The event's text.
 */
function buildEvent(eventBytes: number, lineEnd: string): string {
  const dataBytes = eventBytes - "data: ".length - lineEnd.length
  return buildDataLine(dataBytes) + lineEnd + lineEnd
}

/**
 * Answers one request through {@link sendMcpHttpRequest} with a scripted
 * answer and reads the whole limited body.
 *
 * @param answer - What the server answers.
 * @returns How reading the body ended.
 */
async function readLimitedBody(answer: ScriptedAnswer): Promise<BodyReading> {
  const encoder = new TextEncoder()
  const headers = new Headers()
  if (answer.contentType !== undefined)
    headers.set("content-type", answer.contentType)
  vi.stubGlobal("fetch", () =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of answer.chunks)
              controller.enqueue(encoder.encode(chunk))
            controller.close()
          }
        }),
        { status: answer.status, headers }
      )
    )
  )
  let reportCount = 0
  const response = await sendMcpHttpRequest(UNUSED_ENDPOINT, undefined, () => {
    reportCount += 1
  })
  const reader = response.body?.getReader()
  if (reader === undefined)
    throw new Error("Expected the answer to have a body")
  let readBytes = 0
  try {
    for (let read = await reader.read(); !read.done; read = await reader.read())
      readBytes += read.value.byteLength
  } catch (error) {
    return { readBytes, error, reportCount }
  }
  return { readBytes, error: undefined, reportCount }
}

describe("sendMcpHttpRequest", () => {
  it.each(LINE_END_CASES)(
    "reads an event stream of events as long as the limit each, with lines ended by %s",
    async (_label, lineEnd) => {
      const event = buildEvent(MAXIMUM_MCP_RESPONSE_BYTES, lineEnd)

      const reading = await readLimitedBody({
        status: 200,
        contentType: EVENT_STREAM_TYPE,
        chunks: [event, event]
      })

      expect(reading).toEqual({
        readBytes: event.length * 2,
        error: undefined,
        reportCount: 0
      })
    }
  )

  it.each(LINE_END_CASES)(
    "fails an event stream at an event one byte longer than the limit, with lines ended by %s, and reports it once",
    async (_label, lineEnd) => {
      const reading = await readLimitedBody({
        status: 200,
        contentType: EVENT_STREAM_TYPE,
        chunks: [
          buildEvent(16, lineEnd),
          buildEvent(MAXIMUM_MCP_RESPONSE_BYTES + 1, lineEnd)
        ]
      })

      expect(reading.error).toBeInstanceOf(McpResponseTooLargeError)
      expect(reading.reportCount).toBe(1)
    }
  )

  it("reads an event stream per event whatever case and parameters its media type has", async () => {
    const event = buildDataLine(HALF_LIMIT_DATA_BYTES) + "\n\n"

    const reading = await readLimitedBody({
      status: 200,
      contentType: "Text/Event-Stream ; charset=utf-8",
      chunks: [event, event]
    })

    expect(reading.error).toBeUndefined()
  })

  it("fails an event stream at an event longer than the limit and reports it once", async () => {
    const reading = await readLimitedBody({
      status: 200,
      contentType: EVENT_STREAM_TYPE,
      chunks: [
        "data: first\n\n",
        buildDataLine(HALF_LIMIT_DATA_BYTES) + "\n",
        buildDataLine(HALF_LIMIT_DATA_BYTES) + "\n\n"
      ]
    })

    expect(reading.error).toBeInstanceOf(McpResponseTooLargeError)
    expect(reading.reportCount).toBe(1)
  })

  it("counts a carriage return and line feed split across chunks as one line end", async () => {
    // Read as two line ends, the split would make a blank line that ends the
    // event, and the event longer than the limit would pass.
    const reading = await readLimitedBody({
      status: 200,
      contentType: EVENT_STREAM_TYPE,
      chunks: [
        buildDataLine(HALF_LIMIT_DATA_BYTES) + "\r",
        "\n" + buildDataLine(HALF_LIMIT_DATA_BYTES) + "\r\n\r\n"
      ]
    })

    expect(reading.error).toBeInstanceOf(McpResponseTooLargeError)
  })

  it.each([
    ["a JSON answer", 200, "application/json"],
    ["an answer with no media type", 200, undefined],
    ["an event stream answered with an error status", 500, EVENT_STREAM_TYPE],
    ["an event stream answered with 202", 202, EVENT_STREAM_TYPE],
    [
      "an answer naming a second media type after its parameters",
      200,
      `${EVENT_STREAM_TYPE}; charset=utf-8, application/json`
    ]
  ])(
    "limits the whole body of %s, which the SDK reads whole",
    async (_label, status, contentType) => {
      const event = buildDataLine(HALF_LIMIT_DATA_BYTES) + "\n\n"

      const reading = await readLimitedBody({
        status,
        contentType,
        chunks: [event, event]
      })

      expect(reading.error).toBeInstanceOf(McpResponseTooLargeError)
      expect(reading.reportCount).toBe(1)
    }
  )

  it("reads a whole body as long as the limit", async () => {
    const reading = await readLimitedBody({
      status: 200,
      contentType: "application/json",
      chunks: ["x".repeat(MAXIMUM_MCP_RESPONSE_BYTES)]
    })

    expect(reading).toEqual({
      readBytes: MAXIMUM_MCP_RESPONSE_BYTES,
      error: undefined,
      reportCount: 0
    })
  })
})
