import { describe, expect, it } from "vitest"

import type { AppState, ScenarioKey } from "../app/types"
import { SCENARIOS, stateForScenario } from "../app/scenarios"

function definingState(state: AppState) {
  const lastMessage = state.messages.at(-1)

  return {
    view: state.view,
    pane: state.pane,
    streaming: state.streaming,
    atBottom: state.atBottom,
    messageCount: state.messages.length,
    lastRole: lastMessage?.role ?? null,
    lastStatus: lastMessage?.role === "lys" ? lastMessage.status : null,
    draft: state.draft,
    backend: state.runtime.backend,
    model: state.runtime.model,
    modelProgress: state.runtime.modelProgress,
    startedAt: state.runtime.startedAt
  }
}

const DEFINING_STATES: ReadonlyArray<
  readonly [ScenarioKey, ReturnType<typeof definingState>]
> = [
  [
    "empty",
    {
      view: "chat",
      pane: "runtime",
      streaming: false,
      atBottom: true,
      messageCount: 0,
      lastRole: null,
      lastStatus: null,
      draft: "",
      backend: "running",
      model: "loaded",
      modelProgress: 100,
      startedAt: 1_000
    }
  ],
  [
    "streaming",
    {
      view: "chat",
      pane: "runtime",
      streaming: true,
      atBottom: true,
      messageCount: 2,
      lastRole: "lys",
      lastStatus: "streaming",
      draft: "",
      backend: "running",
      model: "loaded",
      modelProgress: 100,
      startedAt: 1_000
    }
  ],
  [
    "stopped",
    {
      view: "chat",
      pane: "runtime",
      streaming: false,
      atBottom: true,
      messageCount: 2,
      lastRole: "lys",
      lastStatus: "stopped",
      draft: "",
      backend: "running",
      model: "loaded",
      modelProgress: 100,
      startedAt: 1_000
    }
  ],
  [
    "long",
    {
      view: "chat",
      pane: "runtime",
      streaming: false,
      atBottom: true,
      messageCount: 2,
      lastRole: "lys",
      lastStatus: "complete",
      draft: "",
      backend: "running",
      model: "loaded",
      modelProgress: 100,
      startedAt: 1_000
    }
  ],
  [
    "error",
    {
      view: "chat",
      pane: "runtime",
      streaming: false,
      atBottom: true,
      messageCount: 3,
      lastRole: "error",
      lastStatus: null,
      draft: "Now trim the context window without lying to me about it.",
      backend: "running",
      model: "loaded",
      modelProgress: 100,
      startedAt: 1_000
    }
  ],
  [
    "jump",
    {
      view: "chat",
      pane: "runtime",
      streaming: false,
      atBottom: false,
      messageCount: 6,
      lastRole: "lys",
      lastStatus: "complete",
      draft: "",
      backend: "running",
      model: "loaded",
      modelProgress: 100,
      startedAt: 1_000
    }
  ],
  [
    "no-model",
    {
      view: "chat",
      pane: "runtime",
      streaming: false,
      atBottom: true,
      messageCount: 0,
      lastRole: null,
      lastStatus: null,
      draft: "",
      backend: "running",
      model: "none",
      modelProgress: 0,
      startedAt: 1_000
    }
  ],
  [
    "offline",
    {
      view: "chat",
      pane: "runtime",
      streaming: false,
      atBottom: true,
      messageCount: 0,
      lastRole: null,
      lastStatus: null,
      draft: "",
      backend: "stopped",
      model: "none",
      modelProgress: 0,
      startedAt: 1_000
    }
  ],
  [
    "runtime",
    {
      view: "settings",
      pane: "runtime",
      streaming: false,
      atBottom: true,
      messageCount: 0,
      lastRole: null,
      lastStatus: null,
      draft: "",
      backend: "running",
      model: "loaded",
      modelProgress: 100,
      startedAt: 1_000
    }
  ],
  [
    "loading",
    {
      view: "settings",
      pane: "runtime",
      streaming: false,
      atBottom: true,
      messageCount: 0,
      lastRole: null,
      lastStatus: null,
      draft: "",
      backend: "running",
      model: "loading",
      modelProgress: 0,
      startedAt: 1_000
    }
  ]
]

describe("reference scenarios", () => {
  it("exposes the ten scenarios in approved order", () => {
    expect(SCENARIOS.map(({ label }) => label)).toEqual([
      "Empty",
      "Streaming",
      "Stopped reply",
      "Long markdown",
      "Inline error",
      "Jump to latest",
      "No model loaded",
      "Backend stopped",
      "Settings · runtime",
      "Loading a model"
    ])
  })

  it.each(DEFINING_STATES)(
    "creates the defining state for %s",
    (key, expected) => {
      expect(definingState(stateForScenario(key, 1_000))).toEqual(expected)
    }
  )
})
