import { describe, expect, it } from "vitest"
import McpServerLogLines, {
  MAXIMUM_SERVER_LOG_LINE_LENGTH
} from "../../../../src/modules/mcp/mcpServerLogLines"

/**
 * Reads chunks of text in order and collects the lines reported.
 *
 * @param chunks - Text or bytes of each chunk, in arrival order.
 * @returns Every reported line, in report order.
 */
function readChunks(chunks: readonly (string | Uint8Array)[]): string[] {
  const lines: string[] = []
  const reader = new McpServerLogLines((line) => lines.push(line))
  for (const chunk of chunks)
    reader.read(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk)
  return lines
}

describe("McpServerLogLines", () => {
  it("reports each line of one chunk without its line break", () => {
    expect(readChunks(["first\nsecond\n"])).toEqual(["first", "second"])
  })

  it("joins a line split across chunks", () => {
    expect(readChunks(["hel", "lo wor", "ld\nnext\n"])).toEqual([
      "hello world",
      "next"
    ])
  })

  it("removes Windows-style line breaks", () => {
    expect(readChunks(["first\r\nsecond\r\n"])).toEqual(["first", "second"])
  })

  it("decodes a character whose UTF-8 bytes are split across chunks", () => {
    const bytes = Buffer.from("café ✓\n", "utf8")
    const splitInsideE = bytes.indexOf(0xa9)
    const splitInsideCheck = bytes.length - 2

    expect(
      readChunks([
        bytes.subarray(0, splitInsideE),
        bytes.subarray(splitInsideE, splitInsideCheck),
        bytes.subarray(splitInsideCheck)
      ])
    ).toEqual(["café ✓"])
  })

  it("leaves out blank lines", () => {
    expect(readChunks(["first\n\n   \n\t\nsecond\n"])).toEqual([
      "first",
      "second"
    ])
  })

  it("does not report text after the last line break", () => {
    expect(readChunks(["first\nunfinished"])).toEqual(["first"])
  })

  it("reports a line of exactly 2000 characters whole", () => {
    const line = "x".repeat(MAXIMUM_SERVER_LOG_LINE_LENGTH)

    expect(readChunks([`${line}\nnext\n`])).toEqual([line, "next"])
  })

  it("reports a line of 1999 characters held across chunks whole", () => {
    const line = "x".repeat(1999)

    expect(readChunks([line, "\nnext\n"])).toEqual([line, "next"])
  })

  it("cuts a longer line to its first 2000 characters and drops the rest of it", () => {
    expect(readChunks([`${"x".repeat(2500)}\nnext\n`])).toEqual([
      "x".repeat(2000),
      "next"
    ])
  })

  it("reports a line once 2000 characters of it arrived, without waiting for its line break", () => {
    expect(readChunks(["x".repeat(1000), "y".repeat(1000)])).toEqual([
      `${"x".repeat(1000)}${"y".repeat(1000)}`
    ])
  })

  it("reports the first 2000 characters of a longer line once they arrive, before its line break", () => {
    expect(readChunks(["x".repeat(1500), "y".repeat(1500)])).toEqual([
      `${"x".repeat(1500)}${"y".repeat(500)}`
    ])
  })

  it("drops the rest of a cut line across later chunks until its line break", () => {
    expect(
      readChunks([
        "x".repeat(2000),
        "y".repeat(3000),
        "z".repeat(10),
        "\nafter\n"
      ])
    ).toEqual(["x".repeat(2000), "after"])
  })

  it("reports the line after a cut one when it arrives in the same chunk", () => {
    expect(readChunks(["x".repeat(2000), "rest\nafter\n"])).toEqual([
      "x".repeat(2000),
      "after"
    ])
  })
})
