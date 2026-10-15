import { describe, expect, it, vi } from "vitest"
import type { ReplyContextMessage } from "../../../../src/modules/agent/replyModel"
import LlmReplyContextMeter from "../../../../src/modules/chat/llmReplyContextMeter"
import type { LlmContextMeasurement } from "../../../../src/modules/llm/llmRuntimeTypes"
import AgentTool from "../../../../src/modules/tool/tool"
import { READ_TEXT_FILE_TOOL } from "../../support/toolFixtures"

/** Documented template allowance for each message. */
const MESSAGE_TEMPLATE_TOKENS = 8

/** Documented template allowance for each tool call of an earlier round. */
const TOOL_CALL_TEMPLATE_TOKENS = 16

/** Documented template allowance for the tool offer as a whole. */
const TOOL_OFFER_TEMPLATE_TOKENS = 160

/** `read_text_file` as a model is offered it. */
const READ_TEXT_FILE_OFFER = new AgentTool(
  READ_TEXT_FILE_TOOL
).buildAgentFormat()

/** Context length every loaded model reports in these cases. */
const CONTEXT_LENGTH = 8192

/** Context of a round after one call of `read_text_file`. */
const TOOL_ROUND_CONTEXT: readonly ReplyContextMessage[] = Object.freeze([
  { role: "system", content: "You are Lys." },
  { role: "user", content: "Read /a" },
  {
    role: "assistant",
    content: "Let me read it.",
    toolCalls: [
      {
        id: "0199f4e2-0000-7000-8000-000000000001",
        toolName: "read_text_file",
        argumentText: '{"path":"/a"}'
      }
    ]
  },
  {
    role: "tool",
    toolCallId: "0199f4e2-0000-7000-8000-000000000001",
    content: "text of /a"
  }
])

/**
 * Creates the LLM query of a loaded model whose tokenizer gives one token per
 * UTF-16 code unit.
 *
 * @returns A spy answering every query with {@link CONTEXT_LENGTH}.
 */
function createCharacterTokenizer() {
  return vi.fn(
    async (
      _model: string,
      texts: readonly string[]
    ): Promise<LlmContextMeasurement | undefined> => ({
      contextLength: CONTEXT_LENGTH,
      textTokenCounts: texts.map((text) => text.length)
    })
  )
}

describe("LlmReplyContextMeter", () => {
  it("counts each message's text and each tool's JSON with the model's tokenizer, in order", async () => {
    const findLlmContextMeasurement = createCharacterTokenizer()
    const meter = new LlmReplyContextMeter(findLlmContextMeasurement)

    await meter.findReplyContextMeasurement({
      messages: TOOL_ROUND_CONTEXT,
      tools: [READ_TEXT_FILE_OFFER],
      model: "qwen/qwen3-8b"
    })

    expect(findLlmContextMeasurement).toHaveBeenCalledExactlyOnceWith(
      "qwen/qwen3-8b",
      [
        "You are Lys.",
        "Read /a",
        'Let me read it.\nread_text_file {"path":"/a"}',
        "text of /a",
        JSON.stringify(READ_TEXT_FILE_OFFER)
      ]
    )
  })

  it("adds the template allowance to each message, each earlier tool call, and the tool offer", async () => {
    const meter = new LlmReplyContextMeter(createCharacterTokenizer())

    const measurement = await meter.findReplyContextMeasurement({
      messages: TOOL_ROUND_CONTEXT,
      tools: [READ_TEXT_FILE_OFFER],
      model: "qwen/qwen3-8b"
    })

    expect(measurement).toEqual({
      contextLength: CONTEXT_LENGTH,
      messageTokenCounts: [
        "You are Lys.".length + MESSAGE_TEMPLATE_TOKENS,
        "Read /a".length + MESSAGE_TEMPLATE_TOKENS,
        'Let me read it.\nread_text_file {"path":"/a"}'.length +
          MESSAGE_TEMPLATE_TOKENS +
          TOOL_CALL_TEMPLATE_TOKENS,
        "text of /a".length + MESSAGE_TEMPLATE_TOKENS
      ],
      toolTokenCount:
        JSON.stringify(READ_TEXT_FILE_OFFER).length + TOOL_OFFER_TEMPLATE_TOKENS
    })
    expect(Object.isFrozen(measurement)).toBe(true)
    expect(Object.isFrozen(measurement?.messageTokenCounts)).toBe(true)
  })

  it("counts no tool tokens when no tool is offered", async () => {
    const meter = new LlmReplyContextMeter(createCharacterTokenizer())

    const measurement = await meter.findReplyContextMeasurement({
      messages: [{ role: "system", content: "You are Lys." }],
      tools: [],
      model: "qwen/qwen3-8b"
    })

    expect(measurement?.toolTokenCount).toBe(0)
  })

  it("resolves to undefined when the model is not loaded", async () => {
    const meter = new LlmReplyContextMeter(async () => undefined)

    await expect(
      meter.findReplyContextMeasurement({
        messages: [{ role: "system", content: "You are Lys." }],
        tools: [],
        model: "qwen/qwen3-8b"
      })
    ).resolves.toBeUndefined()
  })

  it("rejects with the query's failure unchanged", async () => {
    const queryFailure = new Error("The LLM runtime is unavailable.")
    const meter = new LlmReplyContextMeter(async () => {
      throw queryFailure
    })

    await expect(
      meter.findReplyContextMeasurement({
        messages: [{ role: "system", content: "You are Lys." }],
        tools: [],
        model: "qwen/qwen3-8b"
      })
    ).rejects.toBe(queryFailure)
  })

  it("rejects a measurement that lacks a message's count", async () => {
    const meter = new LlmReplyContextMeter(async () => ({
      contextLength: CONTEXT_LENGTH,
      textTokenCounts: [4]
    }))

    await expect(
      meter.findReplyContextMeasurement({
        messages: [
          { role: "system", content: "You are Lys." },
          { role: "user", content: "Hello" }
        ],
        tools: [],
        model: "qwen/qwen3-8b"
      })
    ).rejects.toThrow("The context measurement has no count for text 1")
  })
})
