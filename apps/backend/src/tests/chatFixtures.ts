import type { ChatCompletionChunk } from "openai/resources/index.mjs"

/** Immutable valid request shared by HTTP and controlled-stream fixtures. */
export const chatTestInput = Object.freeze({
  model: "test",
  message: "Prompt",
  generationOptions: Object.freeze({ temperature: 0.7 })
})

/**
 * Builds a complete deterministic upstream chunk without omitting adapter fields.
 * @param content - Literal assistant delta supplied by the scenario.
 * @param finishReason - Upstream terminal marker, or null while streaming.
 * @returns An independent, structurally valid model chunk.
 */
export function buildChatChunk(
  content: string,
  finishReason: "stop" | null
): ChatCompletionChunk {
  return {
    id: "test",
    object: "chat.completion.chunk",
    created: 0,
    model: "test",
    choices: [{ index: 0, delta: { content }, finish_reason: finishReason }]
  }
}
