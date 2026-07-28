import { describe, expect, it } from "vitest"
import { appReducer, createInitialState } from "../app/state"

describe("appReducer", () => {
  it("stops a partial reply without discarding its text", () => {
    const started = appReducer(createInitialState(), {
      type: "replyStarted",
      messageId: "lys-1"
    })
    const firstDelta = appReducer(started, {
      type: "replyChunkReceived",
      messageId: "lys-1",
      text: "Partial "
    })
    const streamed = appReducer(firstDelta, {
      type: "replyChunkReceived",
      messageId: "lys-1",
      text: "answer"
    })

    const stopped = appReducer(streamed, { type: "replyStopped" })

    expect(stopped.streaming).toBe(false)
    expect(stopped.messages.at(-1)).toMatchObject({
      role: "lys",
      text: "Partial answer",
      status: "stopped"
    })
  })

  it("new chat clears conversation state but preserves settings", () => {
    const configured = appReducer(createInitialState(), {
      type: "configChanged",
      patch: { temperature: 0.95 }
    })
    const withDraft = appReducer(configured, {
      type: "draftChanged",
      draft: "keep nothing"
    })

    const reset = appReducer(withDraft, { type: "newChat" })

    expect(reset.messages).toEqual([])
    expect(reset.draft).toBe("")
    expect(reset.config.temperature).toBe(0.95)
  })

  it("starts in a ready state with a loaded model", () => {
    const state = createInitialState()

    expect(state.runtime).toMatchObject({
      backend: "running",
      model: "loaded",
      modelProgress: 100
    })
  })

  it("ignores model loading while the backend is stopped", () => {
    const stopped = {
      ...createInitialState(),
      runtime: {
        ...createInitialState().runtime,
        backend: "stopped" as const,
        model: "none" as const,
        modelProgress: 0
      }
    }

    const result = appReducer(stopped, { type: "modelLoadStarted" })

    expect(result.runtime.model).toBe("none")
  })

  it.each(["starting", "stopping", "stopped"] as const)(
    "ignores model unload while the backend is %s",
    (backend) => {
      const state = {
        ...createInitialState(),
        runtime: {
          ...createInitialState().runtime,
          backend
        }
      }

      const result = appReducer(state, { type: "modelUnloadStarted" })

      expect(result).toBe(state)
      expect(result.runtime.model).toBe("loaded")
    }
  )

  it("keeps exactly the seven newest runtime log entries in order", () => {
    let state = createInitialState()
    const entries = [
      ["log-1", "00:00:01"],
      ["log-2", "00:00:02"],
      ["log-3", "00:00:03"],
      ["log-4", "00:00:04"],
      ["log-5", "00:00:05"],
      ["log-6", "00:00:06"],
      ["log-7", "00:00:07"],
      ["log-8", "00:00:08"],
      ["log-9", "00:00:09"]
    ] as const

    for (const [id, time] of entries) {
      state = appReducer(state, {
        type: "logAdded",
        entry: { id, time, text: id, tone: "ok" }
      })
    }

    expect(state.runtime.log.map(({ id }) => id)).toEqual([
      "log-3",
      "log-4",
      "log-5",
      "log-6",
      "log-7",
      "log-8",
      "log-9"
    ])
    expect(state.runtime.log.map(({ time }) => time)).toEqual([
      "00:00:03",
      "00:00:04",
      "00:00:05",
      "00:00:06",
      "00:00:07",
      "00:00:08",
      "00:00:09"
    ])
  })
})
