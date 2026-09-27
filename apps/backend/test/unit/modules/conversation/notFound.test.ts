import { conversationNotFoundProblemSchema } from "@lys/protocol"
import { describe, expect, it } from "vitest"
import { createConversationNotFoundProblem } from "../../../src/modules/conversation/notFound"

describe("createConversationNotFoundProblem", () => {
  it("creates the published missing-conversation problem for one occurrence", () => {
    const conversationId = "01900000-0000-7000-8000-000000000001"

    const problem = createConversationNotFoundProblem(
      conversationId,
      `/api/v1/conversations/${conversationId}`
    )

    expect(problem).toEqual({
      type: "urn:lys:problem:conversation:not-found",
      title: "Conversation not found",
      status: 404,
      detail: `Conversation ${conversationId} was not found.`,
      instance: `/api/v1/conversations/${conversationId}`
    })
  })

  it("satisfies the shared problem schema consumed by clients", () => {
    const problem = createConversationNotFoundProblem(
      "01900000-0000-7000-8000-000000000001",
      "/api/v1/chat"
    )

    expect(conversationNotFoundProblemSchema.safeParse(problem).success).toBe(
      true
    )
  })
})
