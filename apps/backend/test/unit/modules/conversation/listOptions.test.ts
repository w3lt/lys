import { describe, expect, it } from "vitest"
import * as z from "zod"
import {
  createConversationListCursor,
  parseConversationListOptions
} from "../../../../src/modules/conversation/listOptions"
import { createFixtureUuidV7 } from "../../support/conversationFixtures"

/** Last row of a nonterminal page, used to create continuation cursors. */
const LAST_LISTED_CONVERSATION = Object.freeze({
  id: createFixtureUuidV7(7),
  title: "Trip plan",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T03:04:05.678Z",
  preview: null
})

/**
 * Creates a cursor from a JSON value, encoded the way list cursors are
 * transmitted.
 *
 * @param value - Cursor payload candidate.
 * @returns Canonical base64 of its UTF-8 JSON.
 */
function createEncodedCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64")
}

/**
 * Gets the failure thrown while parsing list options.
 *
 * @param options - Raw query candidate.
 * @returns The thrown value.
 * @throws If parsing unexpectedly succeeds.
 */
function getParseFailure(
  options: Parameters<typeof parseConversationListOptions>[0]
): unknown {
  try {
    parseConversationListOptions(options)
  } catch (error) {
    return error
  }
  throw new Error("Expected the list options to be rejected")
}

describe("parseConversationListOptions", () => {
  it("lists the first unsearched page with the default size when every value is omitted", () => {
    expect(parseConversationListOptions()).toEqual({
      query: "",
      cursor: undefined,
      limit: 30
    })
    expect(parseConversationListOptions({})).toEqual({
      query: "",
      cursor: undefined,
      limit: 30
    })
  })

  it("trims the search query and keeps the requested page size", () => {
    expect(
      parseConversationListOptions({ query: "  trip  ", limit: 5 })
    ).toEqual({ query: "trip", cursor: undefined, limit: 5 })
  })

  it("accepts a cursor created for the same normalized query", () => {
    const cursor = createConversationListCursor(
      "trip",
      LAST_LISTED_CONVERSATION
    )

    expect(
      parseConversationListOptions({ query: " trip ", cursor, limit: 2 })
    ).toEqual({
      query: "trip",
      cursor: {
        version: 1,
        query: "trip",
        score: null,
        updatedAt: LAST_LISTED_CONVERSATION.updatedAt,
        id: LAST_LISTED_CONVERSATION.id
      },
      limit: 2
    })
  })

  it.each([
    ["an empty query", { query: "   " }],
    ["a query longer than 200 characters", { query: "q".repeat(201) }],
    ["a zero limit", { limit: 0 }],
    ["a limit above 50", { limit: 51 }],
    ["a fractional limit", { limit: 1.5 }]
  ])("rejects %s as invalid input", (_label, options) => {
    const failure = getParseFailure(options)

    expect(failure).toBeInstanceOf(Error)
    expect(failure).toMatchObject({
      statusCode: 400,
      cause: expect.any(z.ZodError)
    })
  })

  it("rejects a cursor bound to another query", () => {
    const cursor = createConversationListCursor(
      "trip",
      LAST_LISTED_CONVERSATION
    )

    expect(
      parseConversationListOptions({ query: "trip", cursor }).cursor
    ).toBeDefined()
    expect(getParseFailure({ query: "budget", cursor })).toMatchObject({
      statusCode: 400
    })
  })

  it("rejects a cursor created for an unsearched list when a query is given", () => {
    const cursor = createConversationListCursor("", LAST_LISTED_CONVERSATION)

    expect(parseConversationListOptions({ cursor }).cursor).toBeDefined()
    expect(getParseFailure({ query: "trip", cursor })).toMatchObject({
      statusCode: 400
    })
  })

  it("rejects a cursor that is not canonical base64", () => {
    const cursor = createConversationListCursor("", LAST_LISTED_CONVERSATION)

    expect(parseConversationListOptions({ cursor }).cursor).toBeDefined()
    expect(getParseFailure({ cursor: `${cursor}\n` })).toMatchObject({
      statusCode: 400
    })
  })

  it("rejects a cursor whose payload is not JSON", () => {
    const cursor = Buffer.from("not json", "utf8").toString("base64")

    expect(getParseFailure({ cursor })).toMatchObject({
      statusCode: 400,
      cause: expect.any(SyntaxError)
    })
  })

  it.each([
    ["an unsupported version", { version: 2 }],
    ["a non-null score", { score: 0.5 }],
    ["an unknown field", { rank: 1 }],
    ["a timestamp without milliseconds", { updatedAt: "2026-01-02T03:04:05Z" }],
    ["an identifier that is not a UUIDv7", { id: "conversation-7" }]
  ])("rejects a cursor with %s", (_label, override) => {
    const cursor = createEncodedCursor({
      version: 1,
      query: "",
      score: null,
      updatedAt: LAST_LISTED_CONVERSATION.updatedAt,
      id: LAST_LISTED_CONVERSATION.id,
      ...override
    })

    expect(getParseFailure({ cursor })).toMatchObject({
      statusCode: 400,
      cause: expect.any(z.ZodError)
    })
  })
})

describe("createConversationListCursor", () => {
  it("encodes the query and activity boundary of the last listed row as base64 JSON", () => {
    const cursor = createConversationListCursor(
      "trip",
      LAST_LISTED_CONVERSATION
    )

    expect(JSON.parse(Buffer.from(cursor, "base64").toString("utf8"))).toEqual({
      version: 1,
      query: "trip",
      score: null,
      updatedAt: LAST_LISTED_CONVERSATION.updatedAt,
      id: LAST_LISTED_CONVERSATION.id
    })
  })

  it("round-trips a non-ASCII query through UTF-8", () => {
    const cursor = createConversationListCursor(
      "école",
      LAST_LISTED_CONVERSATION
    )

    expect(
      parseConversationListOptions({ query: "école", cursor }).cursor?.query
    ).toBe("école")
  })
})
