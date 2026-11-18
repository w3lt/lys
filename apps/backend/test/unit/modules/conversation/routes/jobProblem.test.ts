import { conversationIsJobProblemSchema } from "@lys/protocol"
import { describe, expect, it } from "vitest"
import { createConversationIsJobProblem } from "../../../../../src/modules/conversation/routes/jobProblem"

describe("createConversationIsJobProblem", () => {
  it("creates the published is-job problem for one occurrence", () => {
    const conversationId = "01900000-0000-7000-8000-000000000001"

    const problem = createConversationIsJobProblem(
      conversationId,
      `/api/v1/conversations/${conversationId}`
    )

    expect(problem).toEqual({
      type: "urn:lys:problem:conversation:is-job",
      title: "Conversation is a job",
      status: 409,
      detail: `Conversation ${conversationId} is a job. A job can be read and stopped, and nothing else.`,
      instance: `/api/v1/conversations/${conversationId}`
    })
  })

  it("satisfies the shared problem schema consumed by clients", () => {
    const problem = createConversationIsJobProblem(
      "01900000-0000-7000-8000-000000000001",
      "/api/v1/chat"
    )

    expect(conversationIsJobProblemSchema.safeParse(problem).success).toBe(true)
  })
})
