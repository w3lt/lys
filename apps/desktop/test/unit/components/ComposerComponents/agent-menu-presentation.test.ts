import { describe, expect, it } from "vitest"
import {
  formatAgentChoiceTag,
  formatAgentMenuTitle,
  formatFixedAgentBio,
  formatFixedAgentNote
} from "@/components/ComposerComponents/agent-menu-presentation"
import type {
  AgentChoice,
  ConversationAgent
} from "@/lib/store/agents/conversation-agent"

/** Built-in agent as the composer lists it. */
const CALIGINIA: AgentChoice = Object.freeze({
  code: "caliginia",
  name: "Caliginia",
  bio: "Plain answers.",
  kind: "built-in"
})

/** Agent of the user's own as the composer lists it. */
const POET: AgentChoice = Object.freeze({
  code: "poet",
  name: "Poet",
  bio: "Answers in verse.",
  kind: "custom"
})

/** A conversation's agent the list holds. */
const LISTED_POET: ConversationAgent = Object.freeze({
  status: "listed",
  agent: POET
})

/** A conversation's agent a displayed list no longer holds. */
const DELETED_AGENT: ConversationAgent = Object.freeze({
  status: "deleted",
  code: "historian"
})

/** A conversation's agent while no list is displayed. */
const UNREAD_AGENT: ConversationAgent = Object.freeze({
  status: "unread",
  code: "historian"
})

describe("formatAgentChoiceTag", () => {
  it.each([
    ["the selected agent of the user's own", "selected", POET, "poet"],
    ["the selected built-in agent", "selected", CALIGINIA, "caliginia"],
    ["another built-in agent", "built-in", CALIGINIA, "poet"],
    ["another agent of the user's own", "", POET, "caliginia"]
  ])("tags %s as %o", (_label, tag, agent, selectedAgentCode) => {
    expect(formatAgentChoiceTag(agent, selectedAgentCode)).toBe(tag)
  })
})

describe("formatAgentMenuTitle", () => {
  it.each([LISTED_POET, DELETED_AGENT, UNREAD_AGENT])(
    "invites a choice before a conversation starts, for a $status agent",
    (agent) => {
      expect(formatAgentMenuTitle(agent, false)).toBe("Choose who answers")
    }
  )

  it.each([
    [
      "a listed agent, by name",
      "Poet is fixed for this conversation",
      LISTED_POET
    ],
    [
      "a deleted agent, by code",
      "historian is fixed for this conversation",
      DELETED_AGENT
    ]
  ])("says a started conversation keeps %s", (_label, title, agent) => {
    expect(formatAgentMenuTitle(agent, true)).toBe(title)
  })
})

describe("formatFixedAgentBio", () => {
  it.each([
    ["a listed agent", "Answers in verse.", LISTED_POET],
    ["a deleted agent", "Deleted since.", DELETED_AGENT],
    ["an agent of an unread list", "", UNREAD_AGENT]
  ])("describes %s as %o", (_label, bio, agent) => {
    expect(formatFixedAgentBio(agent)).toBe(bio)
  })
})

describe("formatFixedAgentNote", () => {
  it.each([LISTED_POET, UNREAD_AGENT])(
    "explains that a $status agent stays because its prompt shaped the replies",
    (agent) => {
      expect(formatFixedAgentNote(agent)).toBe(
        "Its prompt has shaped every reply here, so it stays for the whole conversation. To talk to a different agent, start a new one."
      )
    }
  )

  it("says a deleted agent can no longer answer and points to a new conversation", () => {
    expect(formatFixedAgentNote(DELETED_AGENT)).toBe(
      "It can no longer answer here. To keep talking, start a new conversation with another agent."
    )
  })
})
