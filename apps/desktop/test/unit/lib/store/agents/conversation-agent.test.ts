import { CALIGINIA_AGENT_CODE, LYSIPTERA_AGENT_CODE } from "@lys/share"
import { describe, expect, it } from "vitest"
import type { AgentListState } from "@/lib/store/agents"
import {
  buildAgentChoices,
  calculateAgentInitial,
  calculateNewConversationAgentCode,
  findAnsweringAgent,
  findConversationAgent,
  formatConversationAgentName
} from "@/lib/store/agents/conversation-agent"
import {
  buildAgent,
  buildAgentSummary,
  buildBuiltInAgent,
  buildBuiltInAgentSummary
} from "../../../support/agentFixtures"

/** Agent list states in which no list is displayed. */
const UNREAD_AGENT_LISTS: readonly AgentListState[] = Object.freeze([
  Object.freeze({ status: "idle" }),
  Object.freeze({ status: "loading" }),
  Object.freeze({ status: "failed", error: "Lys couldn't read its agents." })
])

/** Displayed list: both built-in agents, then two of the user's own. */
const LOADED_AGENT_LIST: AgentListState = Object.freeze({
  status: "loaded",
  builtInAgents: [
    buildBuiltInAgentSummary(
      buildBuiltInAgent(CALIGINIA_AGENT_CODE, {
        name: "Caliginia",
        bio: "Plain answers."
      })
    ),
    buildBuiltInAgentSummary(
      buildBuiltInAgent(LYSIPTERA_AGENT_CODE, {
        name: "Lysiptera",
        bio: "Long-form writing."
      })
    )
  ],
  agents: [
    buildAgentSummary(
      buildAgent("poet", { name: "Poet", bio: "Answers in verse." })
    ),
    buildAgentSummary(
      buildAgent("critic", { name: "Critic", bio: "Finds the flaw." })
    )
  ],
  isRefreshing: false
})

/** The user's own `poet` as the composer lists it. */
const POET_CHOICE = Object.freeze({
  code: "poet",
  name: "Poet",
  bio: "Answers in verse.",
  kind: "custom"
})

describe("buildAgentChoices", () => {
  it("lists the built-in agents, then the user's own, in listed order", () => {
    expect(buildAgentChoices(LOADED_AGENT_LIST)).toEqual([
      {
        code: CALIGINIA_AGENT_CODE,
        name: "Caliginia",
        bio: "Plain answers.",
        kind: "built-in"
      },
      {
        code: LYSIPTERA_AGENT_CODE,
        name: "Lysiptera",
        bio: "Long-form writing.",
        kind: "built-in"
      },
      POET_CHOICE,
      {
        code: "critic",
        name: "Critic",
        bio: "Finds the flaw.",
        kind: "custom"
      }
    ])
  })

  it.each(UNREAD_AGENT_LISTS)(
    "lists nothing while the agent list is $status",
    (list) => {
      expect(buildAgentChoices(list)).toEqual([])
    }
  )
})

describe("calculateNewConversationAgentCode", () => {
  it.each(["poet", LYSIPTERA_AGENT_CODE])(
    "keeps the selected agent %s while the list holds it",
    (selectedAgentCode) => {
      expect(
        calculateNewConversationAgentCode(selectedAgentCode, LOADED_AGENT_LIST)
      ).toBe(selectedAgentCode)
    }
  )

  it("starts with Caliginia once the list no longer holds the selected agent", () => {
    expect(
      calculateNewConversationAgentCode("historian", LOADED_AGENT_LIST)
    ).toBe(CALIGINIA_AGENT_CODE)
  })

  it.each(UNREAD_AGENT_LISTS)(
    "keeps the selected agent while the agent list is $status, since nothing says it is gone",
    (list) => {
      expect(calculateNewConversationAgentCode("historian", list)).toBe(
        "historian"
      )
    }
  )
})

describe("findConversationAgent", () => {
  it("finds a listed agent of the user's own", () => {
    expect(findConversationAgent(LOADED_AGENT_LIST, "poet")).toEqual({
      status: "listed",
      agent: POET_CHOICE
    })
  })

  it("finds a listed built-in agent", () => {
    expect(
      findConversationAgent(LOADED_AGENT_LIST, LYSIPTERA_AGENT_CODE)
    ).toMatchObject({
      status: "listed",
      agent: { name: "Lysiptera", kind: "built-in" }
    })
  })

  it("reports an agent the displayed list does not hold as deleted, keeping its code", () => {
    expect(findConversationAgent(LOADED_AGENT_LIST, "historian")).toEqual({
      status: "deleted",
      code: "historian"
    })
  })

  it.each(UNREAD_AGENT_LISTS)(
    "claims no deletion while the agent list is $status",
    (list) => {
      expect(findConversationAgent(list, "poet")).toEqual({
        status: "unread",
        code: "poet"
      })
    }
  )
})

describe("findAnsweringAgent", () => {
  it("answers a shown conversation with its own agent, whatever agent is selected", () => {
    expect(
      findAnsweringAgent(LOADED_AGENT_LIST, {
        conversationAgentCode: "poet",
        selectedAgentCode: "critic"
      })
    ).toEqual({ status: "listed", agent: POET_CHOICE })
  })

  it("never replaces a shown conversation's deleted agent with another", () => {
    expect(
      findAnsweringAgent(LOADED_AGENT_LIST, {
        conversationAgentCode: "historian",
        selectedAgentCode: "poet"
      })
    ).toEqual({ status: "deleted", code: "historian" })
  })

  it("answers a new conversation with the selected agent", () => {
    expect(
      findAnsweringAgent(LOADED_AGENT_LIST, {
        conversationAgentCode: undefined,
        selectedAgentCode: "poet"
      })
    ).toEqual({ status: "listed", agent: POET_CHOICE })
  })

  it("answers a new conversation with Caliginia once the selected agent is gone", () => {
    expect(
      findAnsweringAgent(LOADED_AGENT_LIST, {
        conversationAgentCode: undefined,
        selectedAgentCode: "historian"
      })
    ).toMatchObject({
      status: "listed",
      agent: { code: CALIGINIA_AGENT_CODE, name: "Caliginia" }
    })
  })

  it.each(UNREAD_AGENT_LISTS)(
    "knows only the selected code for a new conversation while the agent list is $status",
    (list) => {
      expect(
        findAnsweringAgent(list, {
          conversationAgentCode: undefined,
          selectedAgentCode: "historian"
        })
      ).toEqual({ status: "unread", code: "historian" })
    }
  )
})

describe("formatConversationAgentName", () => {
  it("shows a listed agent under its name", () => {
    expect(
      formatConversationAgentName({ status: "listed", agent: POET_CHOICE })
    ).toBe("Poet")
  })

  it.each(["deleted", "unread"] as const)(
    "shows a %s agent under its code, the only identity left",
    (status) => {
      expect(formatConversationAgentName({ status, code: "historian" })).toBe(
        "historian"
      )
    }
  )
})

describe("calculateAgentInitial", () => {
  it.each([
    ["Poet", "P"],
    ["  critic ", "C"],
    ["élan", "É"],
    ["🦋 Lysiptera", "🦋"],
    ["7 of 9", "7"]
  ])("stands for %o with %o", (name, initial) => {
    expect(calculateAgentInitial(name)).toBe(initial)
  })

  it.each(["", "  \t "])("stands for the blank name %o with ?", (name) => {
    expect(calculateAgentInitial(name)).toBe("?")
  })
})
