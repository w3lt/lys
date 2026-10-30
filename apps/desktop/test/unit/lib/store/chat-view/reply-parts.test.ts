import { describe, expect, it } from "vitest"
import {
  buildChatViewReplyPart,
  buildReplyAnswer,
  buildReplyPartRounds,
  formatToolCallArgumentValue,
  listAnswerCitationNumbers,
  parseToolCallArgumentsView
} from "@/lib/store/chat-view/reply-parts"
import {
  buildChatViewToolCallPart,
  buildReasoningPart,
  buildTextPart,
  buildToolCallPart
} from "../../../support/conversationFixtures"

/** Search of round 0 that is still running. */
const SEARCH_CALL = buildChatViewToolCallPart(
  buildToolCallPart(21, 0, {
    toolName: "web_search",
    argumentText: '{"query":"moths"}',
    status: "running"
  })
)

describe("parseToolCallArgumentsView", () => {
  it("takes the first text argument as the target and shows every value in written order", () => {
    expect(
      parseToolCallArgumentsView(
        '{"limit":5,"query":"night moths","url":"https://a.example/","filters":{"site":"a"},"fresh":true}'
      )
    ).toEqual({
      target: "night moths",
      entries: [
        ["limit", "5"],
        ["query", "night moths"],
        ["url", "https://a.example/"],
        ["filters", '{"site":"a"}'],
        ["fresh", "true"]
      ]
    })
  })

  it("has no target when no argument is text", () => {
    expect(parseToolCallArgumentsView('{"limit":5}')).toEqual({
      target: "",
      entries: [["limit", "5"]]
    })
  })

  it.each([
    ["invalid JSON", '{"query":'],
    ["an array", '["moths"]'],
    ["text", '"moths"'],
    ["a number", "5"],
    ["null", "null"]
  ])("has neither a target nor entries for %s", (_label, argumentText) => {
    expect(parseToolCallArgumentsView(argumentText)).toEqual({
      target: "",
      entries: undefined
    })
  })

  it("returns a frozen view", () => {
    const view = parseToolCallArgumentsView('{"query":"moths"}')

    expect(Object.isFrozen(view)).toBe(true)
    expect(Object.isFrozen(view.entries)).toBe(true)
    expect(view.entries?.every((entry) => Object.isFrozen(entry))).toBe(true)
  })
})

describe("formatToolCallArgumentValue", () => {
  it.each([
    ["text as it is", "two words", "two words"],
    ["a number as JSON", 5, "5"],
    ["a flag as JSON", true, "true"],
    ["null as JSON", null, "null"],
    ["an object as compact JSON", { tags: ["a", "b"] }, '{"tags":["a","b"]}'],
    ["an array as compact JSON", [1, "x"], '[1,"x"]']
  ])("shows %s", (_label, value, text) => {
    expect(formatToolCallArgumentValue(value)).toBe(text)
  })
})

describe("buildChatViewReplyPart", () => {
  it("copies a reasoning or text part as it is, frozen", () => {
    const stored = buildTextPart(20, 0, "Hello")

    const part = buildChatViewReplyPart(stored)

    expect(part).toEqual(stored)
    expect(part).not.toBe(stored)
    expect(Object.isFrozen(part)).toBe(true)
  })

  it("adds a tool call's parsed arguments to its stored fields", () => {
    const stored = buildToolCallPart(21, 0, {
      toolName: "web_search",
      argumentText: '{"query":"moths"}',
      status: "running"
    })

    const part = buildChatViewReplyPart(stored)

    expect(part).toEqual({
      ...stored,
      argumentsView: { target: "moths", entries: [["query", "moths"]] }
    })
    expect(Object.isFrozen(part)).toBe(true)
  })
})

describe("buildReplyPartRounds", () => {
  it("groups parts by round in stored order", () => {
    const reasoning = buildReasoningPart(20, 0, "Search first.")
    const text = buildTextPart(22, 1, "Moths fly.")

    expect(buildReplyPartRounds([reasoning, SEARCH_CALL, text])).toEqual([
      [reasoning, SEARCH_CALL],
      [text]
    ])
  })

  it("has no rounds for a reply with no parts", () => {
    expect(buildReplyPartRounds([])).toEqual([])
  })
})

describe("buildReplyAnswer", () => {
  it("is the text of the last round when that round called no tools", () => {
    expect(
      buildReplyAnswer([
        buildTextPart(20, 0, "Let me search."),
        SEARCH_CALL,
        buildReasoningPart(22, 1, "Found it."),
        buildTextPart(23, 1, "Moths "),
        buildTextPart(24, 1, "fly.")
      ])
    ).toBe("Moths fly.")
  })

  it("is empty while the last round calls tools", () => {
    expect(
      buildReplyAnswer([buildTextPart(20, 0, "Let me search."), SEARCH_CALL])
    ).toBe("")
  })

  it("is empty for a reply with no parts", () => {
    expect(buildReplyAnswer([])).toBe("")
  })
})

describe("listAnswerCitationNumbers", () => {
  it("lists the markers of the answer's prose only, not those of earlier rounds", () => {
    expect(
      listAnswerCitationNumbers([
        buildTextPart(20, 0, "Searching for [3]."),
        SEARCH_CALL,
        buildTextPart(22, 1, "Moths [2] fly `[4]` at night [1].")
      ])
    ).toEqual([2, 1])
  })

  it("lists nothing while the last round calls tools", () => {
    expect(
      listAnswerCitationNumbers([buildTextPart(20, 0, "See [1]."), SEARCH_CALL])
    ).toEqual([])
  })
})
