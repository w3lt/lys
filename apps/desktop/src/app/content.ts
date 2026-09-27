import type { LysConfig } from "./types"

/** Prompt examples shown by the chat starter view. */
export const STARTER_PROMPTS = [
  "What are you?",
  "Sketch the streaming pipeline for a local model.",
  "What happens when the context fills?"
] as const

/** Initial demonstration generation configuration used by the reducer state. */
export const DEFAULT_CONFIG: LysConfig = {
  endpoint: "127.0.0.1:1234",
  model: "qwen3-8b-instruct",
  contextSize: 8192,
  temperature: 0.7,
  maxTokens: 1024,
  stream: true,
  trim: "drop",
  systemPrompt:
    "You are Lys. One model, one conversation. Answer plainly, and never pretend to remember what has fallen out of the window."
}
