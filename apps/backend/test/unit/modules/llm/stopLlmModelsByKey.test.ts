import { describe, expect, it, vi } from "vitest"
import type { LoadedLlmModelInstance } from "../../../src/modules/llm/llmRuntimeTypes"
import {
  stopLlmModelsByKey,
  type ListLoadedLlmModelInstances,
  type StopLoadedLlmModelInstance
} from "../../../src/modules/llm/stopLlmModelsByKey"

/** Requested model key in every case. */
const MODEL_KEY = "qwen/qwen3-8b"

/**
 * Creates one loaded-instance observation.
 *
 * @param modelKey - Canonical key of the instance.
 * @param modelIdentifier - Runtime instance identifier.
 * @returns The frozen observation.
 */
function createInstance(
  modelKey: string,
  modelIdentifier: string
): LoadedLlmModelInstance {
  return Object.freeze({ modelKey, modelIdentifier })
}

/**
 * Creates an inventory query that answers with one snapshot per call.
 *
 * @param snapshots - Snapshots returned for the first, second, ... call.
 * @returns A mock query that rejects once the snapshots are exhausted.
 */
function createInventory(...snapshots: (readonly LoadedLlmModelInstance[])[]) {
  const query = vi.fn<ListLoadedLlmModelInstances>(async () => {
    throw new Error("Unexpected inventory query")
  })
  for (const snapshot of snapshots) {
    query.mockResolvedValueOnce(snapshot)
  }
  return query
}

describe("stopLlmModelsByKey", () => {
  it("returns not-loaded without stopping anything when no instance matches", async () => {
    const listLoaded = createInventory([
      createInstance("other/model", "other/model")
    ])
    const stop = vi.fn<StopLoadedLlmModelInstance>()

    const outcome = await stopLlmModelsByKey(MODEL_KEY, listLoaded, stop)

    expect(outcome).toEqual({ status: "not-loaded", diagnostics: [] })
    expect(stop).not.toHaveBeenCalled()
    expect(listLoaded).toHaveBeenCalledOnce()
  })

  it("stops every exactly matching instance in ascending identifier order", async () => {
    const listLoaded = createInventory(
      [
        createInstance(MODEL_KEY, `${MODEL_KEY}:2`),
        createInstance(`${MODEL_KEY}-instruct`, `${MODEL_KEY}-instruct`),
        createInstance(MODEL_KEY, MODEL_KEY)
      ],
      [createInstance(`${MODEL_KEY}-instruct`, `${MODEL_KEY}-instruct`)]
    )
    const stop = vi.fn<StopLoadedLlmModelInstance>(async () => undefined)

    const outcome = await stopLlmModelsByKey(MODEL_KEY, listLoaded, stop)

    expect(outcome).toEqual({ status: "stopped", diagnostics: [] })
    expect(stop.mock.calls).toEqual([[MODEL_KEY], [`${MODEL_KEY}:2`]])
  })

  it("starts the next stop only after the previous stop settles", async () => {
    const listLoaded = createInventory(
      [createInstance(MODEL_KEY, "a"), createInstance(MODEL_KEY, "b")],
      []
    )
    const firstStop = Promise.withResolvers<void>()
    const stop = vi.fn<StopLoadedLlmModelInstance>(async (identifier) => {
      if (identifier === "a") {
        await firstStop.promise
      }
    })

    const outcome = stopLlmModelsByKey(MODEL_KEY, listLoaded, stop)
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce())
    expect(stop).toHaveBeenLastCalledWith("a")
    firstStop.resolve()

    await expect(outcome).resolves.toMatchObject({ status: "stopped" })
    expect(stop.mock.calls).toEqual([["a"], ["b"]])
  })

  it("keeps stopping after a failed stop and reports it when reconciliation is empty", async () => {
    const listLoaded = createInventory(
      [createInstance(MODEL_KEY, "a"), createInstance(MODEL_KEY, "b")],
      []
    )
    const stop = vi.fn<StopLoadedLlmModelInstance>(async (identifier) => {
      if (identifier === "a") {
        throw new Error("unload timed out")
      }
    })

    const outcome = await stopLlmModelsByKey(MODEL_KEY, listLoaded, stop)

    expect(stop.mock.calls).toEqual([["a"], ["b"]])
    expect(outcome).toEqual({
      status: "stopped",
      diagnostics: [
        {
          operation: "stop-model-instance",
          modelIdentifier: "a",
          message: "unload timed out"
        }
      ]
    })
  })

  it("returns stop-failed with the sorted identifiers still loaded after reconciliation", async () => {
    const listLoaded = createInventory(
      [createInstance(MODEL_KEY, "a"), createInstance(MODEL_KEY, "b")],
      [createInstance(MODEL_KEY, "b"), createInstance(MODEL_KEY, "a")]
    )
    const stop = vi.fn<StopLoadedLlmModelInstance>(async () => {
      throw new Error("refused")
    })

    const outcome = await stopLlmModelsByKey(MODEL_KEY, listLoaded, stop)

    expect(outcome).toEqual({
      status: "stop-failed",
      remainingModelIdentifiers: ["a", "b"],
      diagnostics: [
        {
          operation: "stop-model-instance",
          modelIdentifier: "a",
          message: "refused"
        },
        {
          operation: "stop-model-instance",
          modelIdentifier: "b",
          message: "refused"
        }
      ]
    })
  })

  it("returns stop-failed without diagnostics when stops succeed but instances remain", async () => {
    const listLoaded = createInventory(
      [createInstance(MODEL_KEY, "a")],
      [createInstance(MODEL_KEY, "a:reloaded")]
    )
    const stop = vi.fn<StopLoadedLlmModelInstance>(async () => undefined)

    const outcome = await stopLlmModelsByKey(MODEL_KEY, listLoaded, stop)

    expect(outcome).toEqual({
      status: "stop-failed",
      remainingModelIdentifiers: ["a:reloaded"],
      diagnostics: []
    })
  })

  it("returns runtime-unavailable without stopping when the initial inventory fails", async () => {
    const listLoaded = vi.fn<ListLoadedLlmModelInstances>(async () => {
      throw new Error("socket closed")
    })
    const stop = vi.fn<StopLoadedLlmModelInstance>()

    const outcome = await stopLlmModelsByKey(MODEL_KEY, listLoaded, stop)

    expect(outcome).toEqual({
      status: "runtime-unavailable",
      diagnostics: [
        { operation: "list-initial-model-instances", message: "socket closed" }
      ]
    })
    expect(stop).not.toHaveBeenCalled()
  })

  it("returns runtime-unavailable with stop failures when reconciliation fails", async () => {
    const listLoaded = vi
      .fn<ListLoadedLlmModelInstances>()
      .mockResolvedValueOnce([
        createInstance(MODEL_KEY, "a"),
        createInstance(MODEL_KEY, "b")
      ])
      .mockRejectedValueOnce(new Error("socket closed"))
    const stop = vi.fn<StopLoadedLlmModelInstance>(async (identifier) => {
      if (identifier === "b") {
        throw new Error("refused")
      }
    })

    const outcome = await stopLlmModelsByKey(MODEL_KEY, listLoaded, stop)

    expect(outcome).toEqual({
      status: "runtime-unavailable",
      diagnostics: [
        {
          operation: "stop-model-instance",
          modelIdentifier: "b",
          message: "refused"
        },
        {
          operation: "list-reconciled-model-instances",
          message: "socket closed"
        }
      ]
    })
  })

  it.each([
    ["a non-error value", "offline"],
    ["an error without a message", new Error("")]
  ])(
    "summarizes %s as an unknown runtime failure",
    async (_label, rejection) => {
      const listLoaded = vi.fn<ListLoadedLlmModelInstances>(async () => {
        throw rejection
      })

      const outcome = await stopLlmModelsByKey(MODEL_KEY, listLoaded, vi.fn())

      expect(outcome.diagnostics).toEqual([
        {
          operation: "list-initial-model-instances",
          message: "Unknown LLM runtime failure."
        }
      ])
    }
  )

  it("returns a transitively frozen outcome", async () => {
    const listLoaded = createInventory(
      [createInstance(MODEL_KEY, "a")],
      [createInstance(MODEL_KEY, "a")]
    )
    const stop = vi.fn<StopLoadedLlmModelInstance>(async () => {
      throw new Error("refused")
    })

    const outcome = await stopLlmModelsByKey(MODEL_KEY, listLoaded, stop)

    expect(outcome.status).toBe("stop-failed")
    expect(Object.isFrozen(outcome)).toBe(true)
    expect(Object.isFrozen(outcome.diagnostics)).toBe(true)
    expect(Object.isFrozen(outcome.diagnostics[0])).toBe(true)
    if (outcome.status === "stop-failed") {
      expect(Object.isFrozen(outcome.remainingModelIdentifiers)).toBe(true)
    }
  })
})
