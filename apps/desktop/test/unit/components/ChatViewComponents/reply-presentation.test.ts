import { describe, expect, it } from "vitest"
import {
  calculateReplyWorkDuration,
  createReplyPresentation,
  createReplySourcesPresentation,
  formatReasoningLabel,
  formatReplyDuration,
  formatReplyStepsLabel,
  formatToolCallResultLabel,
  formatToolCallStatus,
  formatToolCallTarget,
  listCitedSourceNumbers,
  parseToolCallArguments
} from "@/components/ChatViewComponents/reply-presentation"
import {
  buildFragmentPart,
  buildToolCallPart,
  FIXTURE_TIMESTAMP
} from "../../support/conversationFixtures"

/** Web search call of round 0 that found sources 1 and 2. */
const SEARCH_CALL = buildToolCallPart(
  20,
  0,
  { toolName: "web_search", argumentText: '{"query":"moths"}' },
  { status: "succeeded", result: "Results", sourceNumbers: [1, 2] }
)

/** Page read of round 1 that showed source 3. */
const READ_CALL = buildToolCallPart(
  21,
  1,
  { toolName: "read_page", argumentText: '{"url":"https://c.example/"}' },
  { status: "succeeded", result: "Page", sourceNumbers: [3] }
)

/** Sources of the fixture conversation. */
const SOURCES = Object.freeze([
  { number: 1, url: "https://a.example/", title: "A" },
  { number: 2, url: "https://b.example/", title: "B" },
  { number: 3, url: "https://c.example/", title: "C" }
])

/**
 * Builds a reasoning part written over a duration.
 *
 * @param sequence - Identity sequence of the part.
 * @param round - Round of the part.
 * @param content - Its text.
 * @param durationMs - Milliseconds from its creation to its last update.
 * @returns The part.
 */
function buildTimedReasoningPart(
  sequence: number,
  round: number,
  content: string,
  durationMs: number
) {
  return {
    ...buildFragmentPart("reasoning", sequence, round, content),
    updatedAt: new Date(
      Date.parse(FIXTURE_TIMESTAMP) + durationMs
    ).toISOString()
  }
}

describe("createReplyPresentation", () => {
  it("shows a reply without tool calls as its text, with no steps", () => {
    const presentation = createReplyPresentation(
      [
        buildFragmentPart("text", 10, 0, "Moths "),
        buildFragmentPart("text", 11, 0, "fly.")
      ],
      false
    )

    expect(presentation).toEqual({
      reasoning: undefined,
      steps: [],
      answer: "Moths fly."
    })
  })

  it("lays rounds that called tools out as steps and the last round's text as the answer", () => {
    const presentation = createReplyPresentation(
      [
        buildFragmentPart("text", 10, 0, "Searching."),
        SEARCH_CALL,
        READ_CALL,
        buildFragmentPart("text", 12, 2, "Moths fly at night [1].")
      ],
      false
    )

    expect(presentation.steps).toEqual([
      { round: 0, text: "Searching.", calls: [SEARCH_CALL] },
      { round: 1, text: "", calls: [READ_CALL] }
    ])
    expect(presentation.answer).toBe("Moths fly at night [1].")
  })

  it("has no answer while the last round's calls are its latest parts", () => {
    const presentation = createReplyPresentation(
      [buildFragmentPart("text", 10, 0, "Searching."), SEARCH_CALL],
      true
    )

    expect(presentation.steps).toHaveLength(1)
    expect(presentation.answer).toBe("")
  })

  it("joins the reply's reasoning across rounds and adds up the time it took", () => {
    const presentation = createReplyPresentation(
      [
        buildTimedReasoningPart(10, 0, "First, search.", 1_500),
        SEARCH_CALL,
        buildTimedReasoningPart(11, 1, "Then answer.", 2_000),
        buildFragmentPart("text", 12, 1, "Done.")
      ],
      false
    )

    expect(presentation.reasoning).toEqual({
      text: "First, search.\n\nThen answer.",
      isThinking: false,
      durationMs: 3_500
    })
  })

  it.each([
    ["streams its reasoning last", true, "reasoning", true],
    ["streams text after its reasoning", true, "text", false],
    ["has ended", false, "reasoning", false]
  ] as const)(
    "says the reply is thinking only while it %s",
    (_label, isStreaming, lastKind, isThinking) => {
      const presentation = createReplyPresentation(
        [
          buildFragmentPart("reasoning", 10, 0, "Hmm"),
          buildFragmentPart(lastKind, 11, 0, "More")
        ],
        isStreaming
      )

      expect(presentation.reasoning?.isThinking).toBe(isThinking)
    }
  )

  it("shows an empty answer for a reply without parts", () => {
    expect(createReplyPresentation([], true)).toEqual({
      reasoning: undefined,
      steps: [],
      answer: ""
    })
  })
})

describe("labels", () => {
  it.each([
    [0, "1s"],
    [1_499, "1s"],
    [1_500, "2s"],
    [61_000, "61s"]
  ])("formats %i ms as %s", (durationMs, label) => {
    expect(formatReplyDuration(durationMs)).toBe(label)
  })

  it("says Thinking while reasoning streams, then how long it took", () => {
    expect(
      formatReasoningLabel({ text: "x", isThinking: true, durationMs: 9_000 })
    ).toBe("Thinking")
    expect(
      formatReasoningLabel({ text: "x", isThinking: false, durationMs: 9_000 })
    ).toBe("Thought for 9s")
  })

  it("counts steps and calls, and says how long an ended reply worked", () => {
    const steps = [
      { round: 0, text: "", calls: [SEARCH_CALL, READ_CALL] },
      { round: 1, text: "", calls: [READ_CALL] }
    ]

    expect(formatReplyStepsLabel(steps, undefined)).toBe(
      "2 steps · 3 tool calls"
    )
    expect(formatReplyStepsLabel(steps.slice(1), 12_000)).toBe(
      "Worked for 12s · 1 step · 1 tool call"
    )
  })

  it.each([
    ["awaiting-approval", "Waiting for approval"],
    ["running", "Running"],
    ["succeeded", "Done"],
    ["failed", "Failed"],
    ["rejected", "Rejected"],
    ["interrupted", "Stopped"]
  ] as const)("labels a %s call %s", (status, label) => {
    expect(formatToolCallStatus(status)).toBe(label)
  })

  it("labels a rejected call's result as the rejection", () => {
    const rejected = buildToolCallPart(
      22,
      0,
      { toolName: "read_page", argumentText: "{}" },
      { status: "rejected", result: "Not now." }
    )

    if (!("result" in rejected) || !("result" in SEARCH_CALL))
      throw new Error("Expected calls with results")

    expect(formatToolCallResultLabel(rejected)).toBe("Rejection")
    expect(formatToolCallResultLabel(SEARCH_CALL)).toBe("Result")
  })

  it("measures an ended reply from its creation to its last update", () => {
    expect(
      calculateReplyWorkDuration({
        createdAt: "2026-01-02T03:04:05.000Z",
        updatedAt: "2026-01-02T03:04:17.500Z"
      })
    ).toBe(12_500)
  })
})

describe("tool call arguments", () => {
  it("lists a JSON object's arguments in written order, other values as JSON", () => {
    expect(
      parseToolCallArguments('{"query":"moths","limit":5,"tags":["a"]}')
    ).toEqual([
      ["query", "moths"],
      ["limit", "5"],
      ["tags", '["a"]']
    ])
  })

  it.each(["{", "[1,2]", "null", '"text"'])(
    "has no named arguments for %s",
    (argumentText) => {
      expect(parseToolCallArguments(argumentText)).toBeUndefined()
    }
  )

  it("names a call by its first text argument, or nothing", () => {
    expect(formatToolCallTarget(SEARCH_CALL)).toBe("moths")
    expect(
      formatToolCallTarget(
        buildToolCallPart(
          23,
          0,
          { toolName: "count", argumentText: '{"n":1,"label":"x"}' },
          { status: "running" }
        )
      )
    ).toBe("x")
    expect(
      formatToolCallTarget(
        buildToolCallPart(
          24,
          0,
          { toolName: "count", argumentText: "not json" },
          { status: "running" }
        )
      )
    ).toBe("")
  })
})

describe("sources", () => {
  it("lists each cited number once, in first-cited order", () => {
    expect(
      listCitedSourceNumbers("A [2], B [10][2], code `[x]`, [1].")
    ).toEqual([2, 10, 1])
  })

  it("lists the sources the reply cites, then those its calls found without citing, with the first tool that found them", () => {
    const presentation = createReplySourcesPresentation(
      [
        SEARCH_CALL,
        READ_CALL,
        buildFragmentPart("text", 12, 2, "Moths [3] fly [9]. Also [1].")
      ],
      SOURCES
    )

    expect(presentation).toEqual({
      cited: [SOURCES[2], SOURCES[0]],
      found: [{ source: SOURCES[1], toolName: "web_search" }]
    })
  })

  it("counts citations in every round's text", () => {
    const presentation = createReplySourcesPresentation(
      [
        buildFragmentPart("text", 10, 0, "Per [2], I will read more."),
        SEARCH_CALL,
        buildFragmentPart("text", 12, 1, "Done.")
      ],
      SOURCES
    )

    expect(presentation.cited).toEqual([SOURCES[1]])
    expect(presentation.found).toEqual([
      { source: SOURCES[0], toolName: "web_search" }
    ])
  })

  it("lists nothing for a reply that cites and finds nothing", () => {
    expect(
      createReplySourcesPresentation(
        [buildFragmentPart("text", 10, 0, "No sources.")],
        SOURCES
      )
    ).toEqual({ cited: [], found: [] })
  })
})
