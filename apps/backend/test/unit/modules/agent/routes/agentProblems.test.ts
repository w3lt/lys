import {
  agentBuiltInProblemSchema,
  agentCodeTakenProblemSchema,
  agentNotFoundProblemSchema,
  conversationAgentMissingProblemSchema
} from "@lys/protocol"
import { describe, expect, it } from "vitest"
import {
  createAgentCodeTakenProblem,
  createAgentNotFoundProblem,
  createBuiltInAgentProblem,
  createConversationAgentMissingProblem
} from "../../../../../src/modules/agent/routes/agentProblems"

describe("createAgentNotFoundProblem", () => {
  it("creates the published missing-agent problem for one occurrence", () => {
    const problem = createAgentNotFoundProblem("lys", "/api/v1/agents/lys")

    expect(problem).toEqual({
      type: "urn:lys:problem:agent:not-found",
      title: "Agent not found",
      status: 404,
      detail: "Agent lys was not found.",
      instance: "/api/v1/agents/lys"
    })
  })

  it("satisfies the shared problem schema consumed by clients", () => {
    const problem = createAgentNotFoundProblem("lys", "/api/v1/agents/lys")

    expect(agentNotFoundProblemSchema.safeParse(problem).success).toBe(true)
  })
})

describe("createBuiltInAgentProblem", () => {
  it("creates the published built-in agent problem for one occurrence", () => {
    const problem = createBuiltInAgentProblem(
      "caliginia",
      "/api/v1/agents/caliginia"
    )

    expect(problem).toEqual({
      type: "urn:lys:problem:agent:built-in",
      title: "Built-in agent cannot be changed",
      status: 409,
      detail: "Agent caliginia is built in and cannot be changed or deleted.",
      instance: "/api/v1/agents/caliginia"
    })
    expect(agentBuiltInProblemSchema.safeParse(problem).success).toBe(true)
  })
})

describe("createConversationAgentMissingProblem", () => {
  it("creates the published missing conversation agent problem for one occurrence", () => {
    const problem = createConversationAgentMissingProblem(
      "web-researcher",
      "/api/v1/chat"
    )

    expect(problem).toEqual({
      type: "urn:lys:problem:conversation:agent-missing",
      title: "Conversation agent missing",
      status: 409,
      detail:
        "The agent web-researcher that answers this conversation no longer exists.",
      instance: "/api/v1/chat"
    })
    expect(
      conversationAgentMissingProblemSchema.safeParse(problem).success
    ).toBe(true)
  })
})

describe("createAgentCodeTakenProblem", () => {
  it("creates the published code-taken problem for one occurrence", () => {
    const problem = createAgentCodeTakenProblem("/api/v1/agents")

    expect(problem).toEqual({
      type: "urn:lys:problem:agent:code-taken",
      title: "Agent code taken",
      status: 409,
      detail: "Another agent already has the requested code.",
      instance: "/api/v1/agents"
    })
  })

  it("satisfies the shared problem schema consumed by clients", () => {
    const problem = createAgentCodeTakenProblem("/api/v1/agents")

    expect(agentCodeTakenProblemSchema.safeParse(problem).success).toBe(true)
  })
})
