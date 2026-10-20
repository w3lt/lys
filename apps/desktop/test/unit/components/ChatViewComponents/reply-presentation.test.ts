import { describe, expect, it } from "vitest"
import { isAnsweredToolCall, type ReplyPart } from "@lys/share"
import {
  calculateReplyCitableSourceNumbers,
  calculateReplyWorkDuration,
  createReplyPresentation,
  createReplySourcesPresentation,
  formatFoundSourcesLabel,
  formatReasoningLabel,
  formatReplyControlName,
  formatReplyDuration,
  formatReplyOutcome,
  formatReplyStepsLabel,
  formatToolCallName,
  formatToolCallResultLabel,
  formatToolCallStatus,
  listReplySources
} from "@/components/ChatViewComponents/reply-presentation"
import {
  buildChatViewToolCallPart,
  buildCompletedChatViewReply,
  buildEndedChatViewReply,
  buildReasoningPart,
  buildStreamingChatViewReply,
  buildTextPart,
  buildToolCallPart,
  buildUserMessage,
  FIXTURE_TIMESTAMP
} from "../../support/conversationFixtures"

/** Stored web search call of round 0 that found sources 1 and 2. */
const STORED_SEARCH_CALL = buildToolCallPart(20, 0, {
  toolName: "web_search",
  argumentText: '{"query":"moths"}',
  status: "succeeded",
  result: "Results",
  sourceNumbers: [1, 2]
})

/** Stored page read of round 1 that showed source 3. */
const STORED_READ_CALL = buildToolCallPart(21, 1, {
  toolName: "read_page",
  argumentText: '{"url":"https://c.example/"}',
  status: "succeeded",
  result: "Page",
  sourceNumbers: [3]
})

/** {@link STORED_SEARCH_CALL} as the chat view holds it. */
const SEARCH_CALL = buildChatViewToolCallPart(STORED_SEARCH_CALL)

/** {@link STORED_READ_CALL} as the chat view holds it. */
const READ_CALL = buildChatViewToolCallPart(STORED_READ_CALL)

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

  it.each([
    ["interrupted", "Stopped"],
    ["failed", "Failed"],
    ["streaming", undefined],
    ["completed", undefined]
  ] as const)("announces a %s reply's outcome as %s", (status, outcome) => {
    expect(formatReplyOutcome(status)).toBe(outcome)
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

  it("names a reply's control by its visible text, then the reply", () => {
    expect(formatReplyControlName("Thought for 3s", 2)).toBe(
      "Thought for 3s, reply 2"
    )
  })

  it.each([
    ["web_search", "night moths", "web_search night moths"],
    ["web_search", "", "web_search"],
    ["", "night moths", "night moths"]
  ])("names a call to %o about %o as %o", (toolName, target, name) => {
    expect(formatToolCallName(toolName, target)).toBe(name)
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

  it("ends at the latest update of any part, which need not be the last part", () => {
    expect(
      calculateReplyWorkDuration({
        createdAt: FIXTURE_TIMESTAMP,
        updatedAt: calculateTimeAfterFixture(30_000),
        parts: [
          buildTimedPart(READ_CALL, 50_000),
          buildTimedPart(SEARCH_CALL, 10_000)
        ]
      })
    ).toBe(50_000)
  })

  it("counts a call that ran or waited for approval until the person pressed Stop", () => {
    const stoppedCall = buildToolCallPart(23, 1, {
      toolName: "read_page",
      argumentText: "{}",
      status: "interrupted"
    })

    expect(
      calculateReplyWorkDuration({
        createdAt: FIXTURE_TIMESTAMP,
        updatedAt: calculateTimeAfterFixture(3_600_000),
        parts: [
          buildTimedPart(SEARCH_CALL, 9_000),
          {
            ...stoppedCall,
            createdAt: calculateTimeAfterFixture(9_500),
            updatedAt: calculateTimeAfterFixture(3_600_000)
          }
        ]
      })
    ).toBe(3_600_000)
  })

  it("leaves out the time before startup recovery interrupted the reply, which keeps its open call's time", () => {
    const recoveredCall = buildToolCallPart(23, 1, {
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
            ...recoveredCall,
            createdAt: calculateTimeAfterFixture(9_500),
            updatedAt: calculateTimeAfterFixture(9_800)
          }
        ]
      })
    ).toBe(9_800)
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

describe("sources", () => {
  it("lists the sources the answer cites, then those its calls found without citing, with the first tool that found them", () => {
    const presentation = createReplySourcesPresentation(
      [SEARCH_CALL, READ_CALL],
      [3, 9, 1],
      SOURCES
    )

    expect(presentation).toEqual({
      cited: [SOURCES[2], SOURCES[0]],
      found: [{ source: SOURCES[1], toolName: "web_search" }]
    })
  })

  it("leaves out numbers that have no source among those the reply may cite", () => {
    expect(
      createReplySourcesPresentation([SEARCH_CALL], [1, 3], SOURCES.slice(0, 2))
    ).toEqual({
      cited: [SOURCES[0]],
      found: [{ source: SOURCES[1], toolName: "web_search" }]
    })
  })

  it("lists nothing for a reply that cites and finds nothing", () => {
    expect(
      createReplySourcesPresentation(
        [buildTextPart(10, 0, "No sources.")],
        [],
        SOURCES
      )
    ).toEqual({ cited: [], found: [] })
  })
})

describe("source scope of each reply", () => {
  it("lets a reply cite the sources its own and earlier replies' calls showed, not those a later reply found", () => {
    const earlier = buildCompletedChatViewReply(2, "Moths like lamps [3].")
    const searching = buildCompletedChatViewReply(4, [STORED_SEARCH_CALL])
    const reading = buildEndedChatViewReply(
      6,
      [STORED_READ_CALL],
      "interrupted"
    )
    const answering = buildStreamingChatViewReply(8, "Lamps [3].")

    const citable = calculateReplyCitableSourceNumbers([
      buildUserMessage(1, "Moths?"),
      earlier,
      buildUserMessage(3, "Search."),
      searching,
      buildUserMessage(5, "Read."),
      reading,
      buildUserMessage(7, "So?"),
      answering
    ])

    expect(
      [...citable].map(([id, numbers]) => [id, [...numbers].sort()])
    ).toEqual([
      [earlier.id, []],
      [searching.id, [1, 2]],
      [reading.id, [1, 2, 3]],
      [answering.id, [1, 2, 3]]
    ])
  })

  it("keeps the sources only a failed reply showed to that reply, since later turns leave it out", () => {
    const failed = buildEndedChatViewReply(2, [STORED_SEARCH_CALL], "failed")
    const later = buildCompletedChatViewReply(4, [
      STORED_READ_CALL,
      buildTextPart(41, 2, "Lamps [1].")
    ])

    const citable = calculateReplyCitableSourceNumbers([
      buildUserMessage(1, "Moths?"),
      failed,
      buildUserMessage(3, "Again."),
      later
    ])

    expect([...(citable.get(failed.id) ?? [])].sort()).toEqual([1, 2])
    expect([...(citable.get(later.id) ?? [])]).toEqual([3])
  })

  it("lists the sources whose numbers a reply may cite, keeping each source object", () => {
    const sources = listReplySources(SOURCES, new Set([1, 3]))

    expect(sources).toEqual([SOURCES[0], SOURCES[2]])
    expect(sources[0]).toBe(SOURCES[0])
    expect(sources[1]).toBe(SOURCES[2])
    expect(listReplySources(SOURCES, new Set())).toEqual([])
  })
})
