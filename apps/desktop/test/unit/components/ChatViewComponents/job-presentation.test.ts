import { describe, expect, it } from "vitest"
import {
  canStopJob,
  createJobCardPresentations,
  createReplyJobsPresentation,
  formatDeliveredReportsLabel,
  formatJobCardState,
  formatJobReportKind,
  formatMessageControlName,
  listMessageJobCards
} from "@/components/ChatViewComponents/job-presentation"
import type { AgentListState } from "@/lib/store/agents"
import type {
  HeldToolCall,
  HeldToolCallAnswer,
  ToolCallInput
} from "@/lib/store/tool-calls"
import { buildAgent, buildAgentSummary } from "../../support/agentFixtures"
import {
  buildChatViewToolCallPart,
  buildCompletedChatViewReply,
  buildJob,
  buildJobCard,
  buildJobReport,
  buildToolCallPart,
  buildUserMessage,
  buildUserMessageWithReports,
  createFixtureUuidV7,
  FIXTURE_JOB_CALL_ID,
  FIXTURE_JOB_ID,
  FIXTURE_JOB_REPLY_ID
} from "../../support/conversationFixtures"
import {
  buildToolCall,
  buildToolDefinition,
  createFixtureApprovalToken
} from "../../support/toolFixtures"

/**
 * Card of job 1, which call 65 of the parent started and call 66 continued.
 */
const CARD = buildJobCard(
  buildJob({ jobCallIds: [FIXTURE_JOB_CALL_ID, createFixtureUuidV7(66)] })
)

/** Card of job 2, which call 68 of the parent started. */
const OTHER_CARD = buildJobCard(
  buildJob({
    id: createFixtureUuidV7(64),
    number: 2,
    jobCallIds: [createFixtureUuidV7(68)]
  })
)

/**
 * Builds a succeeded `delegate_work` call of round 0, as the chat view holds
 * it.
 *
 * @param sequence - Identity sequence of the call: 65 started job 1, 66
 * continued it, and any sequence that no job lists sent no job a message.
 * @returns The call.
 */
function buildDelegationCall(sequence: number) {
  return buildChatViewToolCallPart(
    buildToolCallPart(sequence, 0, {
      toolName: "delegate_work",
      argumentText: '{"agent":"nyx","title":"News","instructions":"Go on."}',
      status: "succeeded",
      result: "Done",
      sourceNumbers: []
    })
  )
}

/**
 * Builds the prompt of a `read_text_file` call that job 1's reply made, not
 * the call that started the job, while it waits for the person.
 *
 * @returns The held prompt.
 */
function buildJobReadPrompt(): HeldToolCall {
  const call = buildToolCall(70, "read_text_file")
  const target: HeldToolCall["target"] = {
    conversationId: FIXTURE_JOB_ID,
    assistantMessageId: FIXTURE_JOB_REPLY_ID,
    callId: call.id
  }
  const readInput = { path: "/notes/todo.md" }
  const clientInput: ToolCallInput = {
    runner: "client",
    toolName: "read_text_file",
    input: readInput
  }
  const definition = buildToolDefinition("read_text_file")
  const answer: Extract<HeldToolCallAnswer, { status: "awaiting-person" }> = {
    status: "awaiting-person",
    definition,
    input: clientInput
  }
  return {
    target,
    call,
    step: "approval",
    approvalToken: createFixtureApprovalToken(1),
    answer
  }
}

describe("job-presentation", () => {
  describe("createJobCardPresentations", () => {
    it("shows a working job that waits for the person as needing approval", () => {
      const nyx = buildAgentSummary(buildAgent("nyx", { name: "Nyx" }))
      const agentList: AgentListState = {
        status: "loaded",
        builtInAgents: [],
        agents: [nyx],
        isRefreshing: false
      }
      const heldPrompt = buildJobReadPrompt()

      expect(
        createJobCardPresentations([buildJob()], [heldPrompt], agentList)[0]
      ).toMatchObject({ agentName: "Nyx", state: "needs-approval" })
      expect(
        createJobCardPresentations(
          [buildJob({ state: "replied" })],
          [heldPrompt],
          agentList
        )[0]?.state
      ).toBe("replied")
      expect(
        createJobCardPresentations([buildJob()], [], agentList)[0]?.state
      ).toBe("working")
    })

    it("shows a job whose agent was deleted by the agent's code", () => {
      const [card] = createJobCardPresentations([buildJob()], [], {
        status: "loaded",
        builtInAgents: [],
        agents: [],
        isRefreshing: false
      })

      expect(card?.agentName).toBe("nyx")
    })
  })

  it.each([
    ["working", "Working"],
    ["needs-approval", "Needs your approval"],
    ["replied", "Replied"],
    ["stopped", "Stopped"],
    ["failed", "Failed"],
    ["interrupted", "Interrupted"]
  ] as const)("formats the %s state as %s", (state, label) => {
    expect(formatJobCardState(state)).toBe(label)
  })

  it.each([
    ["working", true],
    ["needs-approval", true],
    ["replied", false],
    ["stopped", false],
    ["failed", false],
    ["interrupted", false]
  ] as const)("offers Stop for a %s job: %s", (state, isStoppable) => {
    expect(canStopJob(state)).toBe(isStoppable)
  })

  it.each([
    ["note", "Progress note"],
    ["result", "Result"],
    ["failed", "Failed"],
    ["stopped", "Stopped"],
    ["interrupted", "Interrupted"]
  ] as const)("formats a %s report as %s", (kind, label) => {
    expect(formatJobReportKind(kind)).toBe(label)
  })

  it.each([
    ["one report", 1, "1 report delivered with this message"],
    ["two reports", 2, "2 reports delivered with this message"]
  ] as const)(
    "counts %s delivered with a message",
    (_label, reportCount, line) => {
      expect(formatDeliveredReportsLabel(reportCount)).toBe(line)
    }
  )

  it("names a user message's control by its visible text, then the message", () => {
    expect(formatMessageControlName("Reports · 1", 2)).toBe(
      "Reports · 1, message 2"
    )
  })

  it.for([
    ["started it", [65], [CARD], []],
    ["only continued it", [66], [], [CARD]],
    ["started and then continued it", [65, 66], [CARD], []],
    ["sent it no message", [67], [], []]
  ] as const)(
    "shows a job on a reply whose calls %s",
    ([, callSequences, started, continued]) => {
      const parts = callSequences.map(buildDelegationCall)

      expect(createReplyJobsPresentation(parts, [CARD, OTHER_CARD])).toEqual({
        started,
        continued
      })
    }
  )

  describe("listMessageJobCards", () => {
    it("lists for a reply the cards of the jobs its calls sent a message", () => {
      const reply = buildCompletedChatViewReply(12, [
        buildToolCallPart(66, 0, {
          toolName: "delegate_work",
          argumentText: '{"agent":"nyx","title":"News","instructions":"More."}',
          status: "succeeded",
          result: "Job 1 continued.",
          sourceNumbers: []
        })
      ])

      expect(listMessageJobCards(reply, [CARD, OTHER_CARD])).toEqual([CARD])
    })

    it("lists for a user message the cards of the jobs whose reports it delivered", () => {
      const message = buildUserMessageWithReports(
        buildUserMessage(11, "Go on"),
        [buildJobReport()]
      )

      expect(listMessageJobCards(message, [CARD, OTHER_CARD])).toEqual([CARD])
    })
  })
})
