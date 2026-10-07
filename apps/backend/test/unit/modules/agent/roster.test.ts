import { describe, expect, it, vi } from "vitest"
import type {
  ReplyModel,
  ReplyStreamEvent
} from "../../../../src/modules/agent/replyModel"
import AgentRoster from "../../../../src/modules/agent/roster"

/**
 * Creates a roster whose model ends every reply at once.
 *
 * @returns The roster and its model's stream opener.
 */
function createRoster() {
  const openReplyStream = vi.fn<ReplyModel["openReplyStream"]>(async () =>
    (async function* (): AsyncGenerator<ReplyStreamEvent> {
      yield { type: "finish", finishReason: "stop" }
    })()
  )
  const roster = new AgentRoster({
    lysSystemPrompt: "You are Lys.",
    replyModel: { openReplyStream }
  })
  return { roster, openReplyStream }
}

describe("AgentRoster", () => {
  it("gives new conversations Lys, under the code lys", () => {
    expect(createRoster().roster.getDefaultAgent().code).toBe("lys")
  })

  it("answers as Lys with the configured system prompt", async () => {
    const { roster, openReplyStream } = createRoster()

    await roster.getDefaultAgent().createReply({
      history: [],
      userMessageContent: "Hello",
      model: "qwen/qwen3-8b",
      generationOptions: { temperature: 0.4 },
      abortSignal: new AbortController().signal,
      updateAssistantMessageContent: () => true,
      updateAssistantMessageState: () => true,
      sendEvent: vi.fn(),
      reportReplyCancellation: vi.fn(),
      reportReplyFailure: vi.fn()
    })

    expect(openReplyStream).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { role: "system", content: "You are Lys." },
          { role: "user", content: "Hello" }
        ]
      })
    )
  })

  it("finds Lys by her code", () => {
    expect(createRoster().roster.findAgent("lys")?.code).toBe("lys")
  })

  it.each(["web-researcher", "LYS", "lys-2", ""])(
    "finds no agent for the code %j",
    (code) => {
      expect(createRoster().roster.findAgent(code)).toBeUndefined()
    }
  )
})
