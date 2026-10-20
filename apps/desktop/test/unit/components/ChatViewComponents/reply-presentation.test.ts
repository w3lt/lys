import { describe, expect, it } from "vitest"
import type { ReplyPart } from "@lys/share"
import {
  calculateReplySourceNumberLimits,
  calculateReplyWorkDuration,
  createReplyPresentation,
  createReplySourcesPresentation,
  formatFoundSourcesLabel,
  formatReasoningLabel,
  formatReplyDuration,
  formatReplyStepsLabel,
  formatToolCallResultLabel,
  formatToolCallStatus,
  formatToolCallTarget,
  isAnsweredToolCall,
  listCitedSourceNumbers,
  listReplySources,
  parseToolCallArguments
} from "@/components/ChatViewComponents/reply-presentation"
import {
  buildCompletedAssistantMessage,
  buildReasoningPart,
  buildStreamingAssistantMessage,
  buildTextPart,
  buildToolCallPart,
  buildUserMessage,
  FIXTURE_TIMESTAMP
} from "../../support/conversationFixtures"

/** Web search call of round 0 that found sources 1 and 2. */
const SEARCH_CALL = buildToolCallPart(20, 0, {
  toolName: "web_search",
  argumentText: '{"query":"moths"}',
  status: "succeeded",
  result: "Results",
  sourceNumbers: [1, 2]
})

/** Page read of round 1 that showed source 3. */
const READ_CALL = buildToolCallPart(21, 1, {
  toolName: "read_page",
  argumentText: '{"url":"https://c.example/"}',
  status: "succeeded",
  result: "Page",
  sourceNumbers: [3]
})

/** Sources of the fixture conversation. */
const SOURCES = Object.freeze([
  { number: 1, url: "https://a.example/", title: "A" },
  { number: 2, url: "https://b.example/", title: "B" },
  { number: 3, url: "https://c.example/", title: "C" }
])

/**
 * Calculates the time a duration after {@link FIXTURE_TIMESTAMP}.
 *
 * @param durationMs - Milliseconds after the fixture time.
 * @returns The ISO timestamp.
 */
function calculateTimeAfterFixture(durationMs: number): string {
  return new Date(Date.parse(FIXTURE_TIMESTAMP) + durationMs).toISOString()
}

/**
 * Builds a part last updated a duration after it was stored.
 *
 * @param part - Part stored at {@link FIXTURE_TIMESTAMP}.
 * @param durationMs - Milliseconds from its creation to its last update.
 * @returns A copy of the part with that update time.
 */
function buildTimedPart<Part extends ReplyPart>(
  part: Part,
  durationMs: number
): Part {
  return { ...part, updatedAt: calculateTimeAfterFixture(durationMs) }
}

describe("createReplyPresentation", () => {
  it("shows a reply without tool calls as its text, with no steps", () => {
    const presentation = createReplyPresentation(
      [buildTextPart(10, 0, "Moths "), buildTextPart(11, 0, "fly.")],
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
        buildTextPart(10, 0, "Searching."),
        SEARCH_CALL,
        READ_CALL,
        buildTextPart(12, 2, "Moths fly at night [1].")
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
      [buildTextPart(10, 0, "Searching."), SEARCH_CALL],
      true
    )

    expect(presentation.steps).toHaveLength(1)
    expect(presentation.answer).toBe("")
  })

  it("joins the reply's reasoning across rounds and adds up the time it took", () => {
    const presentation = createReplyPresentation(
      [
        buildTimedPart(buildReasoningPart(10, 0, "First, search."), 1_500),
        SEARCH_CALL,
        buildTimedPart(buildReasoningPart(11, 1, "Then answer."), 2_000),
        buildTextPart(12, 1, "Done.")
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
    [
      "streams its reasoning last",
      true,
      buildReasoningPart(11, 0, "More"),
      true
    ],
    [
      "streams text after its reasoning",
      true,
      buildTextPart(11, 0, "More"),
      false
    ],
    ["has ended", false, buildReasoningPart(11, 0, "More"), false]
  ] as const)(
    "says the reply is thinking only while it %s",
    (_label, isStreaming, lastPart, isThinking) => {
      const presentation = createReplyPresentation(
        [buildReasoningPart(10, 0, "Hmm"), lastPart],
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
    const rejected = buildToolCallPart(22, 0, {
      toolName: "read_page",
      argumentText: "{}",
      status: "rejected",
      result: "Not now."
    })

    if (!isAnsweredToolCall(rejected) || !isAnsweredToolCall(SEARCH_CALL))
      throw new Error("Expected calls with results")

    expect(formatToolCallResultLabel(rejected)).toBe("Rejection")
    expect(formatToolCallResultLabel(SEARCH_CALL)).toBe("Result")
  })

  it.each([
    ["awaiting-approval", { status: "awaiting-approval" }, false],
    ["running", { status: "running" }, false],
    ["interrupted", { status: "interrupted" }, false],
    ["succeeded", { status: "succeeded", result: "", sourceNumbers: [] }, true],
    ["failed", { status: "failed", result: "Not run." }, true],
    ["rejected", { status: "rejected", result: "Not now." }, true]
  ] as const)("says whether a %s call has its result", (_label, state, has) => {
    const call = buildToolCallPart(22, 0, {
      toolName: "read_page",
      argumentText: "{}",
      ...state
    })

    expect(isAnsweredToolCall(call)).toBe(has)
  })

  it.each([
    ["some are cited", [SOURCES[0]], "2 more"],
    ["none is cited", [], "Sources · 2 found"]
  ] as const)("labels the found sources when %s", (_label, cited, label) => {
    const found = [
      { source: SOURCES[1], toolName: "web_search" },
      { source: SOURCES[2], toolName: "read_page" }
    ]

    expect(formatFoundSourcesLabel({ cited, found })).toBe(label)
  })
})

describe("calculateReplyWorkDuration", () => {
  it("measures an ended reply from its creation to the last update of its parts", () => {
    expect(
      calculateReplyWorkDuration({
        createdAt: FIXTURE_TIMESTAMP,
        updatedAt: calculateTimeAfterFixture(30_000),
        parts: [
          buildTimedPart(SEARCH_CALL, 9_000),
          buildTimedPart(buildTextPart(12, 1, "Moths."), 12_500)
        ]
      })
    ).toBe(12_500)
  })

  it("leaves out the time before startup recovery interrupted the reply's open call", () => {
    const runningCall = buildToolCallPart(23, 1, {
      toolName: "read_page",
      argumentText: "{}",
      status: "interrupted"
    })

    expect(
      calculateReplyWorkDuration({
        createdAt: FIXTURE_TIMESTAMP,
        updatedAt: calculateTimeAfterFixture(86_400_000),
        parts: [
          buildTimedPart(SEARCH_CALL, 9_000),
          {
            ...runningCall,
            createdAt: calculateTimeAfterFixture(9_500),
            updatedAt: calculateTimeAfterFixture(86_400_000)
          }
        ]
      })
    ).toBe(9_500)
  })

  it("measures a reply without parts to its update time", () => {
    expect(
      calculateReplyWorkDuration({
        createdAt: FIXTURE_TIMESTAMP,
        updatedAt: calculateTimeAfterFixture(2_000),
        parts: []
      })
    ).toBe(2_000)
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
        buildToolCallPart(23, 0, {
          toolName: "count",
          argumentText: '{"n":1,"label":"x"}',
          status: "running"
        })
      )
    ).toBe("x")
    expect(
      formatToolCallTarget(
        buildToolCallPart(24, 0, {
          toolName: "count",
          argumentText: "not json",
          status: "running"
        })
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

  it("lists the sources the answer cites, then those its calls found without citing, with the first tool that found them", () => {
    const presentation = createReplySourcesPresentation(
      [SEARCH_CALL, READ_CALL],
      "Moths [3] fly [9]. Also [1].",
      SOURCES
    )

    expect(presentation).toEqual({
      cited: [SOURCES[2], SOURCES[0]],
      found: [{ source: SOURCES[1], toolName: "web_search" }]
    })
  })

  it("counts only the answer's citations, not those in the text of its steps, which shows no links", () => {
    const parts = [
      buildTextPart(10, 0, "Per [2], I will read more."),
      SEARCH_CALL,
      buildTextPart(12, 1, "Done.")
    ]
    const answer = createReplyPresentation(parts, false).answer

    const presentation = createReplySourcesPresentation(parts, answer, SOURCES)

    expect(presentation.cited).toEqual([])
    expect(presentation.found).toEqual([
      { source: SOURCES[0], toolName: "web_search" },
      { source: SOURCES[1], toolName: "web_search" }
    ])
  })

  it("leaves out numbers that have no source among those the reply may cite", () => {
    expect(
      createReplySourcesPresentation(
        [SEARCH_CALL],
        "See [1] and [3].",
        SOURCES.slice(0, 2)
      )
    ).toEqual({
      cited: [SOURCES[0]],
      found: [{ source: SOURCES[1], toolName: "web_search" }]
    })
  })

  it("lists nothing for a reply that cites and finds nothing", () => {
    expect(
      createReplySourcesPresentation(
        [buildTextPart(10, 0, "No sources.")],
        "No sources.",
        SOURCES
      )
    ).toEqual({ cited: [], found: [] })
  })
})

describe("source scope of each reply", () => {
  it("lets a reply cite the sources its own and earlier replies' calls showed, not those a later reply found", () => {
    const earlier = buildCompletedAssistantMessage(2, "Moths like lamps [3].")
    const searching = buildCompletedAssistantMessage(4, [SEARCH_CALL])
    const reading = buildCompletedAssistantMessage(6, [READ_CALL])
    const answering = buildStreamingAssistantMessage(8, "Lamps [3].")

    const limits = calculateReplySourceNumberLimits([
      buildUserMessage(1, "Moths?"),
      earlier,
      buildUserMessage(3, "Search."),
      searching,
      buildUserMessage(5, "Read."),
      reading,
      buildUserMessage(7, "So?"),
      answering
    ])

    expect([...limits]).toEqual([
      [earlier.id, 0],
      [searching.id, 2],
      [reading.id, 3],
      [answering.id, 3]
    ])
    expect(listReplySources(SOURCES, limits.get(earlier.id) ?? 0)).toEqual([])
    expect(listReplySources(SOURCES, 2)).toEqual(SOURCES.slice(0, 2))
  })
})
