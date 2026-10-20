import type { ChatGenerationEvent } from "@lys/protocol"
import type { ReplyPart, ToolCallReplyPart } from "@lys/share"
import { describe, expect, it, vi } from "vitest"
import ReplyPartSequence, {
  type ReplyPartDraft,
  type ReplyPartSequenceDependencies,
  type ReplyToolCallChange
} from "../../../../src/modules/agent/replyPartSequence"
import {
  createFixtureUuidV7,
  createToolCallPart,
  FIXTURE_TIMESTAMP
} from "../../support/conversationFixtures"

/** Time the scripted store gives every fragment. */
const FRAGMENT_TIME = "2026-01-02T03:04:06.000Z"

/** Stored running call the cases change. */
const RUNNING_CALL = createToolCallPart(
  {
    sequence: 30,
    round: 0,
    toolName: "web_search",
    argumentText: '{"query":"moths"}'
  },
  { status: "running" }
)

/** Store outcomes a case changes; every write is accepted by default. */
type ScriptedStore = Partial<
  Pick<
    ReplyPartSequenceDependencies,
    "createReplyPart" | "updateReplyPartContent" | "updateReplyToolCall"
  >
>

/**
 * Stores a part as the scripted store does by default.
 *
 * @param draft - Part the sequence asks to store.
 * @param sequence - Identity sequence a reasoning or text part gets.
 * @returns A tool call as {@link RUNNING_CALL} drafted anew, or the fragment
 * part stored at the fixture time.
 */
function createScriptedPart(
  draft: ReplyPartDraft,
  sequence: number
): ReplyPart {
  if (draft.kind === "tool-call") return { ...RUNNING_CALL, ...draft }
  return {
    ...draft,
    id: createFixtureUuidV7(sequence),
    createdAt: FIXTURE_TIMESTAMP,
    updatedAt: FIXTURE_TIMESTAMP
  }
}

/**
 * Stores a call change as the scripted store does by default.
 *
 * @param _toolCallId - Call the change is for.
 * @param change - The call's next state.
 * @returns {@link RUNNING_CALL} in the new state, numbering a success's
 * sources.
 */
function updateScriptedToolCall(
  _toolCallId: string,
  change: ReplyToolCallChange
): ToolCallReplyPart {
  if (change.status !== "succeeded") return { ...RUNNING_CALL, ...change }
  return {
    ...RUNNING_CALL,
    status: "succeeded",
    result: change.result,
    sourceNumbers: change.sources.map((source) => source.number)
  }
}

/**
 * Creates a sequence over a scripted store and records what it sends.
 *
 * @param store - Store outcomes the case changes.
 * @returns The sequence, spies over its store, and the events it sent.
 * @remarks By default the store accepts every write: a new reasoning or text
 * part gets the next fixture identity, a fragment is stored at
 * {@link FRAGMENT_TIME}, and a call change returns {@link RUNNING_CALL} in
 * its new state.
 */
function createSequence(store: ScriptedStore = {}) {
  const events: ChatGenerationEvent[] = []
  let nextSequence = 1
  const createReplyPart = vi.fn<
    ReplyPartSequenceDependencies["createReplyPart"]
  >(
    store.createReplyPart ??
      ((draft) => createScriptedPart(draft, nextSequence++))
  )
  const updateReplyPartContent = vi.fn<
    ReplyPartSequenceDependencies["updateReplyPartContent"]
  >(store.updateReplyPartContent ?? (() => FRAGMENT_TIME))
  const updateReplyToolCall = vi.fn<
    ReplyPartSequenceDependencies["updateReplyToolCall"]
  >(store.updateReplyToolCall ?? updateScriptedToolCall)
  const sequence = new ReplyPartSequence({
    createReplyPart,
    updateReplyPartContent,
    updateReplyToolCall,
    sendEvent: (event) => {
      events.push(event)
    }
  })
  return {
    sequence,
    createReplyPart,
    updateReplyPartContent,
    updateReplyToolCall,
    events
  }
}

describe("ReplyPartSequence", () => {
  it("stores a round's first fragment as a new part and its later fragments of the same kind in that part", () => {
    const run = createSequence()

    expect(run.sequence.updateReplyText(0, "Hi")).toBe(true)
    expect(run.sequence.updateReplyText(0, " there")).toBe(true)

    expect(run.createReplyPart.mock.calls).toEqual([
      [{ kind: "text", round: 0, content: "Hi" }]
    ])
    expect(run.updateReplyPartContent.mock.calls).toEqual([
      [createFixtureUuidV7(1), " there"]
    ])
    expect(run.events).toEqual([
      {
        type: "reply-part",
        part: {
          kind: "text",
          id: createFixtureUuidV7(1),
          round: 0,
          content: "Hi",
          createdAt: FIXTURE_TIMESTAMP,
          updatedAt: FIXTURE_TIMESTAMP
        }
      },
      {
        type: "reply-part-delta",
        partId: createFixtureUuidV7(1),
        content: " there",
        updatedAt: FRAGMENT_TIME
      }
    ])
  })

  it("starts a new part when the kind or the round of the fragments changes", () => {
    const run = createSequence()

    run.sequence.updateReplyReasoning(0, "Think")
    run.sequence.updateReplyText(0, "Hi")
    run.sequence.updateReplyReasoning(0, "More")
    run.sequence.updateReplyReasoning(1, "Next round")

    expect(run.createReplyPart.mock.calls).toEqual([
      [{ kind: "reasoning", round: 0, content: "Think" }],
      [{ kind: "text", round: 0, content: "Hi" }],
      [{ kind: "reasoning", round: 0, content: "More" }],
      [{ kind: "reasoning", round: 1, content: "Next round" }]
    ])
    expect(run.updateReplyPartContent).not.toHaveBeenCalled()
  })

  it("stores and sends a new call, after which text starts a new part", () => {
    const run = createSequence()
    run.sequence.updateReplyText(0, "Looking")
    const draft = {
      kind: "tool-call",
      id: RUNNING_CALL.id,
      round: 0,
      toolName: "web_search",
      argumentText: '{"query":"moths"}',
      status: "running"
    } as const

    expect(run.sequence.createReplyToolCall(draft)).toBe(true)
    run.sequence.updateReplyText(0, " again")

    expect(run.createReplyPart.mock.calls).toEqual([
      [{ kind: "text", round: 0, content: "Looking" }],
      [draft],
      [{ kind: "text", round: 0, content: " again" }]
    ])
    expect(run.events[1]).toEqual({
      type: "reply-part",
      part: { ...RUNNING_CALL, ...draft }
    })
  })

  it("sends a succeeded call's sources before the call, and no sources event when it shows none", () => {
    const run = createSequence()
    const sources = [
      { number: 2, url: "https://moths.example/", title: "Moths" }
    ]

    run.sequence.updateReplyToolCall(RUNNING_CALL.id, {
      status: "succeeded",
      result: "Source [2]",
      sources
    })
    run.sequence.updateReplyToolCall(RUNNING_CALL.id, {
      status: "succeeded",
      result: "",
      sources: []
    })

    expect(run.events).toEqual([
      { type: "sources", sources },
      {
        type: "reply-part",
        part: {
          ...RUNNING_CALL,
          status: "succeeded",
          result: "Source [2]",
          sourceNumbers: [2]
        }
      },
      {
        type: "reply-part",
        part: {
          ...RUNNING_CALL,
          status: "succeeded",
          result: "",
          sourceNumbers: []
        }
      }
    ])
  })

  it("sends the stored call for every other change", () => {
    const run = createSequence()

    run.sequence.updateReplyToolCall(RUNNING_CALL.id, {
      status: "failed",
      result: "Tavily is down."
    })

    expect(run.updateReplyToolCall.mock.calls).toEqual([
      [RUNNING_CALL.id, { status: "failed", result: "Tavily is down." }]
    ])
    expect(run.events).toEqual([
      {
        type: "reply-part",
        part: { ...RUNNING_CALL, status: "failed", result: "Tavily is down." }
      }
    ])
  })

  it.each([
    [
      "a new part",
      { createReplyPart: () => undefined },
      (sequence: ReplyPartSequence) => sequence.updateReplyText(0, "Hi")
    ],
    [
      "a new call",
      { createReplyPart: () => undefined },
      (sequence: ReplyPartSequence) =>
        sequence.createReplyToolCall({
          kind: "tool-call",
          id: RUNNING_CALL.id,
          round: 0,
          toolName: "web_search",
          argumentText: "{}",
          status: "running"
        })
    ],
    [
      "a call change with sources",
      { updateReplyToolCall: () => undefined },
      (sequence: ReplyPartSequence) =>
        sequence.updateReplyToolCall(RUNNING_CALL.id, {
          status: "succeeded",
          result: "Source [1]",
          sources: [{ number: 1, url: "https://a.example/", title: "A" }]
        })
    ]
  ])(
    "returns false and sends nothing when the store refuses %s",
    (_label, store, write) => {
      const run = createSequence(store)

      expect(write(run.sequence)).toBe(false)
      expect(run.events).toEqual([])
    }
  )

  it("returns false and sends nothing when the store refuses a fragment", () => {
    const run = createSequence({ updateReplyPartContent: () => undefined })
    run.sequence.updateReplyText(0, "Hi")

    expect(run.sequence.updateReplyText(0, " refused")).toBe(false)

    expect(run.events).toHaveLength(1)
  })

  it("starts a new part for the next fragment after the store refused a part", () => {
    const createReplyPart = vi
      .fn<ReplyPartSequenceDependencies["createReplyPart"]>()
      .mockReturnValueOnce(undefined)
    const run = createSequence({ createReplyPart })
    createReplyPart.mockImplementation((draft) => createScriptedPart(draft, 9))

    run.sequence.updateReplyText(0, "Refused")
    run.sequence.updateReplyText(0, "Stored")

    expect(createReplyPart).toHaveBeenCalledTimes(2)
    expect(run.updateReplyPartContent).not.toHaveBeenCalled()
  })

  it("lets a store failure through without sending anything", () => {
    const failure = new Error("Database is closed")
    const run = createSequence({
      createReplyPart: () => {
        throw failure
      }
    })

    expect(() => run.sequence.updateReplyReasoning(0, "Think")).toThrow(failure)
    expect(run.events).toEqual([])
  })
})
