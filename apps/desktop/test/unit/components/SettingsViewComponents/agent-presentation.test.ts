import { MAXIMUM_AGENT_BIO_LENGTH, MAXIMUM_AGENT_NAME_LENGTH } from "@lys/share"
import { describe, expect, it } from "vitest"
import {
  formatAgentActivityStatus,
  formatAgentDraftProblem,
  formatAgentListStatus,
  formatAgentPromptMeasure,
  formatCustomAgentCount
} from "@/components/SettingsViewComponents/agent-presentation"
import type { AgentDraftProblem } from "@/lib/store/agents"
import { buildAgent, buildAgentSummary } from "../../support/agentFixtures"

describe("formatAgentDraftProblem", () => {
  it.each<[AgentDraftProblem, string]>([
    [{ kind: "name-missing" }, "An agent needs a name."],
    [
      { kind: "name-too-long" },
      `A name is at most ${MAXIMUM_AGENT_NAME_LENGTH} characters.`
    ],
    [
      { kind: "name-taken", name: "Reviewer" },
      "Another agent already goes by Reviewer. Pick another name."
    ],
    [
      { kind: "code-malformed" },
      "A code is lowercase letters and digits, in groups joined by single hyphens, and cannot end with a hyphen."
    ],
    [
      { kind: "code-taken", code: "reviewer" },
      "Another agent already uses the code reviewer. Pick another code, or leave it empty."
    ],
    [{ kind: "bio-missing" }, "Give the agent a one-line bio."],
    [
      { kind: "bio-too-long" },
      `A bio is at most ${MAXIMUM_AGENT_BIO_LENGTH} characters.`
    ],
    [{ kind: "system-prompt-missing" }, "Write a system prompt, even one line."]
  ])("explains %o", (problem, sentence) => {
    expect(formatAgentDraftProblem(problem)).toBe(sentence)
  })
})

describe("formatAgentListStatus", () => {
  it("asks to start the backend while it is not running, whatever the list holds", () => {
    expect(formatAgentListStatus(false, { status: "idle" })).toBe(
      "Start the backend to manage agents."
    )
    expect(
      formatAgentListStatus(false, { status: "failed", error: "Offline." })
    ).toBe("Start the backend to manage agents.")
  })

  it("shows a failed read while the backend runs", () => {
    expect(
      formatAgentListStatus(true, {
        status: "failed",
        error: "Lys couldn't read the agents."
      })
    ).toBe("Lys couldn't read the agents.")
  })

  it("says nothing while the agents can be shown or are being read", () => {
    expect(formatAgentListStatus(true, { status: "idle" })).toBe("")
    expect(formatAgentListStatus(true, { status: "loading" })).toBe("")
    expect(
      formatAgentListStatus(true, {
        status: "loaded",
        agents: [buildAgentSummary(buildAgent("reviewer"))],
        isRefreshing: true
      })
    ).toBe("")
  })
})

describe("formatCustomAgentCount", () => {
  it("says the agents are deletable, with how many are saved when there are any", () => {
    expect(formatCustomAgentCount(0)).toBe("deletable")
    expect(formatCustomAgentCount(1)).toBe("1 saved · deletable")
    expect(formatCustomAgentCount(3)).toBe("3 saved · deletable")
  })
})

describe("formatAgentPromptMeasure", () => {
  it("states characters, estimated tokens, and their share of the window", () => {
    expect(formatAgentPromptMeasure("x".repeat(412), 8192)).toBe(
      "412 chars · ~112 tokens · 1.4% of 8.2k"
    )
  })

  it("measures an empty prompt", () => {
    expect(formatAgentPromptMeasure("", 8192)).toBe(
      "0 chars · ~0 tokens · 0.0% of 8.2k"
    )
  })

  it("omits the share without a window", () => {
    expect(formatAgentPromptMeasure("x".repeat(37), 0)).toBe(
      "37 chars · ~10 tokens"
    )
  })
})

describe("formatAgentActivityStatus", () => {
  it("announces a pending save or deletion, and nothing otherwise", () => {
    expect(formatAgentActivityStatus({ status: "saving" })).toBe("Saving…")
    expect(formatAgentActivityStatus({ status: "deleting" })).toBe("Deleting…")
    expect(formatAgentActivityStatus({ status: "idle", failure: null })).toBe(
      ""
    )
    expect(
      formatAgentActivityStatus({
        status: "idle",
        failure: "Lys couldn't save."
      })
    ).toBe("")
    expect(formatAgentActivityStatus({ status: "confirming-delete" })).toBe("")
  })
})
