import { REPLIES, STARTER_PROMPTS } from "./content"
import { createInitialState } from "./state"
import type { AppState, Message, ScenarioKey } from "./types"

export const SCENARIOS: ReadonlyArray<{
  key: ScenarioKey
  label: string
  number: string
}> = [
  { key: "empty", label: "Empty", number: "01" },
  { key: "streaming", label: "Streaming", number: "02" },
  { key: "stopped", label: "Stopped reply", number: "03" },
  { key: "long", label: "Long markdown", number: "04" },
  { key: "error", label: "Inline error", number: "05" },
  { key: "jump", label: "Jump to latest", number: "06" },
  { key: "no-model", label: "No model loaded", number: "07" },
  { key: "offline", label: "Backend stopped", number: "08" },
  { key: "runtime", label: "Settings · runtime", number: "09" },
  { key: "loading", label: "Loading a model", number: "10" }
]

const user = (id: string, text: string): Message => ({
  id,
  role: "user",
  text
})

const lys = (
  id: string,
  text: string,
  status: "streaming" | "complete" | "stopped" = "complete"
): Message => ({ id, role: "lys", text, status })

export function stateForScenario(key: ScenarioKey, now = Date.now()): AppState {
  const ready = createInitialState(now)

  switch (key) {
    case "empty":
      return ready
    case "streaming":
      return {
        ...ready,
        streaming: true,
        messages: [
          user("scenario-user-1", STARTER_PROMPTS[1]),
          lys("scenario-lys-1", REPLIES.pipeline.slice(0, 220), "streaming")
        ]
      }
    case "stopped":
      return {
        ...ready,
        messages: [
          user("scenario-user-1", STARTER_PROMPTS[1]),
          lys("scenario-lys-1", REPLIES.pipeline.slice(0, 240), "stopped")
        ]
      }
    case "long":
      return {
        ...ready,
        messages: [
          user("scenario-user-1", STARTER_PROMPTS[1]),
          lys("scenario-lys-1", REPLIES.pipeline)
        ]
      }
    case "error":
      return {
        ...ready,
        draft: "Now trim the context window without lying to me about it.",
        messages: [
          user("scenario-user-1", STARTER_PROMPTS[0]),
          lys("scenario-lys-1", REPLIES.identity),
          {
            id: "scenario-error-1",
            role: "error",
            title: "stream failed",
            text: "The connection to LM Studio dropped mid-request. Nothing was lost — your message is back in the composer."
          }
        ]
      }
    case "jump":
      return {
        ...ready,
        atBottom: false,
        messages: [
          user("scenario-user-1", STARTER_PROMPTS[0]),
          lys("scenario-lys-1", REPLIES.identity),
          user("scenario-user-2", "And when the context fills?"),
          lys("scenario-lys-2", REPLIES.context),
          user("scenario-user-3", STARTER_PROMPTS[1]),
          lys("scenario-lys-3", REPLIES.pipeline)
        ]
      }
    case "no-model":
      return {
        ...ready,
        runtime: { ...ready.runtime, model: "none", modelProgress: 0 }
      }
    case "offline":
      return {
        ...ready,
        runtime: {
          ...ready.runtime,
          backend: "stopped",
          model: "none",
          modelProgress: 0
        }
      }
    case "runtime":
      return { ...ready, view: "settings", pane: "runtime" }
    case "loading":
      return {
        ...ready,
        view: "settings",
        pane: "runtime",
        runtime: {
          ...ready.runtime,
          model: "loading",
          modelProgress: 0
        }
      }
  }
}
