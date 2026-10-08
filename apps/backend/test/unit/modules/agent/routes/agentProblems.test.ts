import {
  agentCodeTakenProblemSchema,
  agentNotFoundProblemSchema
} from "@lys/protocol"
import { describe, expect, it } from "vitest"
import {
  createAgentCodeTakenProblem,
  createAgentNotFoundProblem,
  createChatAgentNotFoundProblem
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

describe("createChatAgentNotFoundProblem", () => {
  it("creates the missing-agent problem without claiming that no agent has the code", () => {
    const problem = createChatAgentNotFoundProblem(
      "web-researcher",
      "/api/v1/chat"
    )

    expect(problem).toEqual({
      type: "urn:lys:problem:agent:not-found",
      title: "Agent not found",
      status: 404,
      detail: "No agent that can answer chats has the code web-researcher.",
      instance: "/api/v1/chat"
    })
    expect(agentNotFoundProblemSchema.safeParse(problem).success).toBe(true)
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
