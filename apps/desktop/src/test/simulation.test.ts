import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  createProgressSimulation,
  createTextSimulation,
  replyForPrompt
} from "../app/simulation"
import { REPLIES } from "../app/content"

describe("simulation controllers", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("streams deterministic delta chunks and completes once", () => {
    const chunks: string[] = []
    const complete = vi.fn()

    createTextSimulation({
      text: "abcdef",
      chunkSize: 2,
      intervalMs: 20,
      onChunk: (text) => chunks.push(text),
      onComplete: complete
    })

    vi.runAllTimers()

    expect(chunks).toEqual(["ab", "cd", "ef"])
    expect(complete).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("does not emit after cancellation", () => {
    const onChunk = vi.fn()
    const complete = vi.fn()
    const controller = createTextSimulation({
      text: "abcdef",
      chunkSize: 2,
      intervalMs: 20,
      onChunk,
      onComplete: complete
    })

    vi.advanceTimersByTime(20)
    controller.cancel()
    vi.runAllTimers()

    expect(onChunk).toHaveBeenCalledOnce()
    expect(complete).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("does not complete when the final text chunk cancels the controller", () => {
    const complete = vi.fn()
    let controller: ReturnType<typeof createTextSimulation>

    controller = createTextSimulation({
      text: "ab",
      chunkSize: 2,
      intervalMs: 20,
      onChunk: () => controller.cancel(),
      onComplete: complete
    })

    vi.runAllTimers()

    expect(complete).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("reports model progress from zero through one hundred", () => {
    const progress: number[] = []
    const complete = vi.fn()

    createProgressSimulation({
      intervalMs: 20,
      step: 25,
      onProgress: (value) => progress.push(value),
      onComplete: complete
    })

    vi.runAllTimers()

    expect(progress).toEqual([25, 50, 75, 100])
    expect(complete).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("does not complete when the final progress update cancels the controller", () => {
    const complete = vi.fn()
    let controller: ReturnType<typeof createProgressSimulation>

    controller = createProgressSimulation({
      intervalMs: 20,
      step: 100,
      onProgress: () => controller.cancel(),
      onComplete: complete
    })

    vi.runAllTimers()

    expect(complete).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe("replyForPrompt", () => {
  it("selects replies by reference priority", () => {
    expect(
      replyForPrompt(
        "Who are you? Cancel streaming after the context window fills."
      )
    ).toBe(REPLIES.identity)
    expect(
      replyForPrompt("Cancel this streaming response before its context fills.")
    ).toBe(REPLIES.stop)
    expect(
      replyForPrompt("How should an SSE pipeline handle the context?")
    ).toBe(REPLIES.pipeline)
    expect(replyForPrompt("What happens when the token window fills?")).toBe(
      REPLIES.context
    )
    expect(replyForPrompt("Tell me more.")).toBe(REPLIES.generic)
  })
})
