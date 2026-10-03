import { describe, expect, it } from "vitest"
import * as z from "zod"
import {
  createAgentListCursor,
  parseAgentListOptions
} from "../../../../src/modules/agent/listOptions"
import { createConversationListCursor } from "../../../../src/modules/conversation/listOptions"
import { createFixtureUuidV7 } from "../../support/conversationFixtures"

/** Last row of a nonterminal page, used to create continuation cursors. */
const LAST_LISTED_AGENT = Object.freeze({
  code: "web-researcher",
  name: "Researcher",
  bio: "Searches the web.",
  createdAt: "2026-01-02T03:04:05.678Z",
  updatedAt: "2026-01-03T00:00:00.000Z"
})

/** Valid cursor payload each invalid case varies in one field. */
const CURSOR_PAYLOAD = Object.freeze({
  version: 1,
  createdAt: LAST_LISTED_AGENT.createdAt,
  code: LAST_LISTED_AGENT.code
})

/**
 * Encodes a JSON value the way list cursors are transmitted.
 *
 * @param value - Cursor payload candidate.
 * @returns Canonical base64 of its UTF-8 JSON.
 */
function createEncodedCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64")
}

/**
 * Gets the failure thrown while parsing list options with a cursor.
 *
 * @param cursor - Cursor text candidate.
 * @returns The thrown value.
 * @throws If parsing unexpectedly succeeds.
 */
function getCursorFailure(cursor: string): unknown {
  try {
    parseAgentListOptions({ cursor })
  } catch (error) {
    return error
  }
  throw new Error("Expected the cursor to be rejected")
}

describe("parseAgentListOptions", () => {
  it("lists the first page with the default size when every value is omitted", () => {
    expect(parseAgentListOptions({})).toEqual({ cursor: undefined, limit: 30 })
  })

  it("keeps the requested page size", () => {
    expect(parseAgentListOptions({ limit: 5 })).toEqual({
      cursor: undefined,
      limit: 5
    })
  })

  it("continues after the agent a created cursor names", () => {
    const cursor = createAgentListCursor(LAST_LISTED_AGENT)

    expect(parseAgentListOptions({ cursor, limit: 2 })).toEqual({
      cursor: CURSOR_PAYLOAD,
      limit: 2
    })
  })

  it("rejects a cursor that is not canonical base64 as invalid input", () => {
    const cursor = createAgentListCursor(LAST_LISTED_AGENT)

    expect(getCursorFailure(`${cursor}\n`)).toMatchObject({ statusCode: 400 })
  })

  it("rejects a cursor whose payload is not JSON, keeping the cause", () => {
    const cursor = Buffer.from("not json", "utf8").toString("base64")

    expect(getCursorFailure(cursor)).toMatchObject({
      statusCode: 400,
      cause: expect.any(SyntaxError)
    })
  })

  it.each([
    ["an unsupported version", { version: 2 }],
    ["an unknown field", { rank: 1 }],
    ["a timestamp without milliseconds", { createdAt: "2026-01-02T03:04:05Z" }],
    ["a code that is not a slug", { code: "Web Researcher" }]
  ])("rejects a cursor with %s, keeping the cause", (_label, change) => {
    const failure = getCursorFailure(
      createEncodedCursor({ ...CURSOR_PAYLOAD, ...change })
    )

    expect(failure).toBeInstanceOf(Error)
    expect(failure).toMatchObject({
      statusCode: 400,
      cause: expect.any(z.ZodError)
    })
  })

  it("rejects a conversation list cursor", () => {
    const cursor = createConversationListCursor("", {
      id: createFixtureUuidV7(1),
      title: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      preview: null
    })

    expect(getCursorFailure(cursor)).toMatchObject({ statusCode: 400 })
  })
})
