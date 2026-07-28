import type { LysConfig } from "./types"

export const STARTER_PROMPTS = [
  "What are you?",
  "Sketch the streaming pipeline for a local model.",
  "What happens when the context fills?"
] as const

export const MODEL_OPTIONS = [
  {
    name: "qwen3-8b-instruct",
    meta: "8.2B · Q4_K_M · 4.9 GB",
    size: "4.9 GB"
  },
  {
    name: "mistral-nemo-12b",
    meta: "12.2B · Q4_K_M · 7.1 GB",
    size: "7.1 GB"
  },
  {
    name: "phi-4-mini",
    meta: "3.8B · Q6_K · 2.4 GB",
    size: "2.4 GB"
  }
] as const

export const REPLIES = {
  identity:
    "A voice running on the model you loaded. Nothing more, and nothing behind it.\n\nI have no tools, no memory past this window, no way to reach outward. When you close me, I stop existing in any way that matters.\n\nAsk me something. I'd rather be used than described.",
  pipeline:
    "Three moving parts. Only one of them is interesting.\n\n1. **Request** — POST to `/v1/chat/completions` with `stream: true`.\n2. **Parse** — read the SSE body as it arrives, split on blank lines, drop `[DONE]`.\n3. **Paint** — append each delta to the last message and let the view follow.\n\n```ts\nconst ctrl = new AbortController();\nconst res = await fetch(`${base}/v1/chat/completions`, {\n  method: 'POST',\n  signal: ctrl.signal,\n  headers: { 'content-type': 'application/json' },\n  body: JSON.stringify({ model, messages, stream: true })\n});\n\nfor await (const chunk of sse(res.body)) {\n  if (chunk === '[DONE]') break;\n  append(JSON.parse(chunk).choices[0].delta.content ?? '');\n}\n```\n\n### Where it breaks\n\n- The reader is never cancelled, so Stop leaves a ghost stream writing into nothing.\n- Deltas arrive faster than paint, and the transcript stutters.\n- Context fills, and the oldest turns quietly stop being sent.\n\n> Cancellation is not an edge case. It is the feature. Keep the abort controller somewhere the UI can reach.\n\nThe partial text you already have is real. Keep it.",
  context:
    "The window is finite, so something has to go.\n\nIn v1 the oldest **complete** turns are dropped from the request while the transcript stays whole on screen. You see everything. I only remember the recent part and the system prompt.\n\nIt is a compromise, and an honest one — no cutoff marker, no pretending. When it starts to bite, you will feel it before you see it.",
  stop: "Stop cuts the stream, not the thought.\n\nWhatever arrived stays on screen, marked **Stopped**, and stays in context. If it was going somewhere useful, tell me to continue and I will pick it up from what survived.",
  generic:
    "Understood.\n\nI have the shape of what you want, but not enough of the particulars to be worth reading yet. Give me the constraint that matters most — the one you would not trade away — and I will work from there.\n\nBe specific. Vagueness costs you tokens and me nothing."
} as const

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
