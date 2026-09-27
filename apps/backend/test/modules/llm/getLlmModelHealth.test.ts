import { describe, expect, it, vi } from "vitest"
import * as z from "zod"
import { getLlmModelHealth } from "../../../src/modules/llm/getLlmModelHealth"
import type { ListLoadedLlmModelInstances } from "../../../src/modules/llm/stopLlmModelsByKey"

/** Requested model key in every case. */
const MODEL_KEY = "qwen/qwen3-8b"

/**
 * Creates a monotonic clock that returns the given readings in order.
 *
 * @param readingsMs - Successive clock values in milliseconds.
 * @returns A mock clock that throws once the readings are exhausted.
 */
function createClock(...readingsMs: number[]) {
  const clock = vi.fn<() => number>(() => {
    throw new Error("Unexpected clock reading")
  })
  for (const reading of readingsMs) {
    clock.mockReturnValueOnce(reading)
  }
  return clock
}

describe("getLlmModelHealth", () => {
  it("reports ready when the fresh inventory contains the exact key", async () => {
    const listLoaded = vi.fn<ListLoadedLlmModelInstances>(async () => [
      { modelKey: MODEL_KEY, modelIdentifier: `${MODEL_KEY}:2` }
    ])

    const outcome = await getLlmModelHealth(
      MODEL_KEY,
      listLoaded,
      createClock(100, 112)
    )

    expect(outcome).toEqual({
      health: { modelId: MODEL_KEY, status: "ready", latencyMs: 12 },
      diagnostics: []
    })
    expect(listLoaded).toHaveBeenCalledOnce()
  })

  it("reports model-not-loaded when only a different key is loaded", async () => {
    const listLoaded = vi.fn<ListLoadedLlmModelInstances>(async () => [
      { modelKey: `${MODEL_KEY}-instruct`, modelIdentifier: "other" }
    ])

    const outcome = await getLlmModelHealth(
      MODEL_KEY,
      listLoaded,
      createClock(0, 0)
    )

    expect(outcome).toEqual({
      health: {
        modelId: MODEL_KEY,
        status: "not-ready",
        reason: "model-not-loaded",
        latencyMs: 0
      },
      diagnostics: []
    })
  })

  it("reports runtime-unavailable and retains the inventory rejection for reporting", async () => {
    const failure = new Error("socket closed")
    const listLoaded = vi.fn<ListLoadedLlmModelInstances>(async () => {
      throw failure
    })
    const reporter = vi.fn()

    const outcome = await getLlmModelHealth(
      MODEL_KEY,
      listLoaded,
      createClock(5, 9)
    )

    expect(outcome.health).toEqual({
      modelId: MODEL_KEY,
      status: "not-ready",
      reason: "runtime-unavailable",
      latencyMs: 4
    })
    expect(outcome.diagnostics).toHaveLength(1)
    outcome.diagnostics[0]?.handleLlmModelHealthFailureReport(reporter)
    expect(reporter.mock.calls[0]?.[0]).toBe(failure)
  })

  it("rounds the measured interval to whole milliseconds", async () => {
    const listLoaded = vi.fn<ListLoadedLlmModelInstances>(async () => [])

    const outcome = await getLlmModelHealth(
      MODEL_KEY,
      listLoaded,
      createClock(10.2, 13.7)
    )

    expect(outcome.health.latencyMs).toBe(4)
  })

  it("reads the clock before the query starts and after it settles", async () => {
    const inventory = Promise.withResolvers<[]>()
    const clock = createClock(0, 30)

    const outcome = getLlmModelHealth(MODEL_KEY, () => inventory.promise, clock)
    expect(clock).toHaveBeenCalledOnce()
    inventory.resolve([])

    await expect(outcome).resolves.toMatchObject({
      health: { latencyMs: 30 }
    })
    expect(clock).toHaveBeenCalledTimes(2)
  })

  it("returns a frozen outcome whose diagnostics are frozen", async () => {
    const unavailable = await getLlmModelHealth(
      MODEL_KEY,
      async () => {
        throw new Error("offline")
      },
      createClock(0, 1)
    )
    const ready = await getLlmModelHealth(
      MODEL_KEY,
      async () => [{ modelKey: MODEL_KEY, modelIdentifier: MODEL_KEY }],
      createClock(0, 1)
    )

    for (const outcome of [unavailable, ready]) {
      expect(Object.isFrozen(outcome)).toBe(true)
      expect(Object.isFrozen(outcome.health)).toBe(true)
      expect(Object.isFrozen(outcome.diagnostics)).toBe(true)
    }
  })

  it("propagates a synchronous query invocation failure instead of reporting unavailability", async () => {
    const invocationFailure = new Error("query could not start")

    await expect(
      getLlmModelHealth(
        MODEL_KEY,
        () => {
          throw invocationFailure
        },
        createClock(0, 1)
      )
    ).rejects.toBe(invocationFailure)
  })

  it("propagates a clock failure", async () => {
    const clockFailure = new Error("clock unavailable")

    await expect(
      getLlmModelHealth(
        MODEL_KEY,
        async () => [],
        () => {
          throw clockFailure
        }
      )
    ).rejects.toBe(clockFailure)
  })

  it("rejects a result that violates the health response contract", async () => {
    await expect(
      getLlmModelHealth("", async () => [], createClock(0, 1))
    ).rejects.toBeInstanceOf(z.ZodError)
  })
})
