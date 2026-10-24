import { describe, expect, it, vi } from "vitest"
import type { LoadedLlmModelInstance } from "../../../../src/modules/llm/llmRuntimeTypes"
import {
  stopLysLlmModelInstances,
  type ListLoadedLlmModelInstances,
  type StopLoadedLlmModelInstance
} from "../../../../src/modules/llm/stopLysLlmModelInstances"
import InMemoryLysLlmInstanceStore from "../../support/inMemoryLysLlmInstanceStore"

/** Requested model key in every case. */
const MODEL_KEY = "qwen/qwen3-8b"

/** Identifier of the first instance Lys loaded of the requested model. */
const LYS_IDENTIFIER = `${MODEL_KEY}@lys-000001`

/** Identifier of a second instance Lys loaded of the requested model. */
const SECOND_LYS_IDENTIFIER = `${MODEL_KEY}@lys-000002`

/** Identifier of an instance Lys loaded of another model. */
const OTHER_LYS_IDENTIFIER = "other/model@lys-000003"

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

/**
 * Creates a record that holds identifiers saved earlier.
 *
 * @param instanceIdentifiers - Saved identifiers.
 * @returns The record.
 */
function createSavedRecord(
  ...instanceIdentifiers: readonly string[]
): InMemoryLysLlmInstanceStore {
  return new InMemoryLysLlmInstanceStore({
    status: "read",
    instanceIdentifiers: new Set(instanceIdentifiers)
  })
}

/**
 * Stops the requested model's instances with the given engine operations.
 *
 * @param listLoadedLlmModelInstances - Inventory query.
 * @param stopLoadedLlmModelInstance - Stop command.
 * @param lysLlmInstanceStore - Record of the instances Lys loaded.
 * @returns The outcome.
 */
async function stopRequestedModel(
  listLoadedLlmModelInstances: ListLoadedLlmModelInstances,
  stopLoadedLlmModelInstance: StopLoadedLlmModelInstance,
  lysLlmInstanceStore: InMemoryLysLlmInstanceStore
) {
  return await stopLysLlmModelInstances(
    MODEL_KEY,
    { listLoadedLlmModelInstances, stopLoadedLlmModelInstance },
    lysLlmInstanceStore
  )
}

describe("stopLysLlmModelInstances", () => {
  it("stops only the saved instance of the key, never one another program loaded, and saves the record without it", async () => {
    const listLoaded = createInventory(
      [
        createInstance(MODEL_KEY, MODEL_KEY),
        createInstance(MODEL_KEY, LYS_IDENTIFIER),
        createInstance(MODEL_KEY, `${MODEL_KEY}:2`),
        createInstance("other/model", OTHER_LYS_IDENTIFIER)
      ],
      [
        createInstance(MODEL_KEY, MODEL_KEY),
        createInstance(MODEL_KEY, `${MODEL_KEY}:2`),
        createInstance("other/model", OTHER_LYS_IDENTIFIER)
      ]
    )
    const stop = vi.fn<StopLoadedLlmModelInstance>(async () => undefined)
    const record = createSavedRecord(LYS_IDENTIFIER, OTHER_LYS_IDENTIFIER)

    const outcome = await stopRequestedModel(listLoaded, stop, record)

    expect(outcome).toEqual({ status: "stopped", diagnostics: [] })
    expect(stop.mock.calls).toEqual([[LYS_IDENTIFIER]])
    expect(record.listSavedIdentifierSets()).toEqual([
      new Set([OTHER_LYS_IDENTIFIER])
    ])
  })

  it("returns not-loaded without stopping or saving when only other programs' instances of the key are loaded", async () => {
    const listLoaded = createInventory([
      createInstance(MODEL_KEY, MODEL_KEY),
      createInstance(MODEL_KEY, `${MODEL_KEY}:2`)
    ])
    const stop = vi.fn<StopLoadedLlmModelInstance>()
    const record = createSavedRecord(OTHER_LYS_IDENTIFIER)

    const outcome = await stopRequestedModel(listLoaded, stop, record)

    expect(outcome).toEqual({ status: "not-loaded", diagnostics: [] })
    expect(stop).not.toHaveBeenCalled()
    expect(listLoaded).toHaveBeenCalledOnce()
    expect(record.listSavedIdentifierSets()).toEqual([])
  })

  it("never stops an instance of the key whose saved identifier is gone, as after LM Studio restarts", async () => {
    const listLoaded = createInventory([createInstance(MODEL_KEY, MODEL_KEY)])
    const stop = vi.fn<StopLoadedLlmModelInstance>()
    const record = createSavedRecord(LYS_IDENTIFIER)

    const outcome = await stopRequestedModel(listLoaded, stop, record)

    expect(outcome).toEqual({ status: "not-loaded", diagnostics: [] })
    expect(stop).not.toHaveBeenCalled()
  })

  it("stops two saved instances of the key one after another, in identifier order", async () => {
    const listLoaded = createInventory(
      [
        createInstance(MODEL_KEY, SECOND_LYS_IDENTIFIER),
        createInstance(MODEL_KEY, LYS_IDENTIFIER)
      ],
      []
    )
    const firstStop = Promise.withResolvers<void>()
    const stop = vi.fn<StopLoadedLlmModelInstance>(async (identifier) => {
      if (identifier === LYS_IDENTIFIER) {
        await firstStop.promise
      }
    })
    const record = createSavedRecord(LYS_IDENTIFIER, SECOND_LYS_IDENTIFIER)

    const outcome = stopRequestedModel(listLoaded, stop, record)
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce())
    expect(stop.mock.calls).toEqual([[LYS_IDENTIFIER]])
    firstStop.resolve()

    await expect(outcome).resolves.toEqual({
      status: "stopped",
      diagnostics: []
    })
    expect(stop.mock.calls).toEqual([[LYS_IDENTIFIER], [SECOND_LYS_IDENTIFIER]])
    expect(record.listSavedIdentifierSets()).toEqual([new Set()])
  })

  it("keeps stopping after a failed stop and reports it when reconciliation finds both gone", async () => {
    const listLoaded = createInventory(
      [
        createInstance(MODEL_KEY, LYS_IDENTIFIER),
        createInstance(MODEL_KEY, SECOND_LYS_IDENTIFIER)
      ],
      []
    )
    const stop = vi.fn<StopLoadedLlmModelInstance>(async (identifier) => {
      if (identifier === LYS_IDENTIFIER) {
        throw new Error("unload timed out")
      }
    })
    const record = createSavedRecord(LYS_IDENTIFIER, SECOND_LYS_IDENTIFIER)

    const outcome = await stopRequestedModel(listLoaded, stop, record)

    expect(stop.mock.calls).toEqual([[LYS_IDENTIFIER], [SECOND_LYS_IDENTIFIER]])
    expect(outcome).toEqual({
      status: "stopped",
      diagnostics: [
        {
          operation: "stop-model-instance",
          modelIdentifier: LYS_IDENTIFIER,
          message: "unload timed out"
        }
      ]
    })
  })

  it("returns stop-failed with the saved instances still loaded, keeping them on the record", async () => {
    const listLoaded = createInventory(
      [
        createInstance(MODEL_KEY, LYS_IDENTIFIER),
        createInstance(MODEL_KEY, SECOND_LYS_IDENTIFIER),
        createInstance(MODEL_KEY, MODEL_KEY)
      ],
      [
        createInstance(MODEL_KEY, SECOND_LYS_IDENTIFIER),
        createInstance(MODEL_KEY, MODEL_KEY),
        createInstance(MODEL_KEY, LYS_IDENTIFIER)
      ]
    )
    const stop = vi.fn<StopLoadedLlmModelInstance>(async () => {
      throw new Error("refused")
    })
    const record = createSavedRecord(LYS_IDENTIFIER, SECOND_LYS_IDENTIFIER)

    const outcome = await stopRequestedModel(listLoaded, stop, record)

    expect(outcome).toEqual({
      status: "stop-failed",
      remainingModelIdentifiers: [LYS_IDENTIFIER, SECOND_LYS_IDENTIFIER],
      diagnostics: [
        {
          operation: "stop-model-instance",
          modelIdentifier: LYS_IDENTIFIER,
          message: "refused"
        },
        {
          operation: "stop-model-instance",
          modelIdentifier: SECOND_LYS_IDENTIFIER,
          message: "refused"
        }
      ]
    })
    expect(record.listSavedIdentifierSets()).toEqual([
      new Set([LYS_IDENTIFIER, SECOND_LYS_IDENTIFIER])
    ])
  })

  it("returns stopped when only an instance another program loaded remains", async () => {
    const listLoaded = createInventory(
      [createInstance(MODEL_KEY, LYS_IDENTIFIER)],
      [createInstance(MODEL_KEY, MODEL_KEY)]
    )
    const stop = vi.fn<StopLoadedLlmModelInstance>(async () => undefined)
    const record = createSavedRecord(LYS_IDENTIFIER)

    const outcome = await stopRequestedModel(listLoaded, stop, record)

    expect(outcome).toEqual({ status: "stopped", diagnostics: [] })
  })

  it("drops saved identifiers whose instances are gone when it saves", async () => {
    const listLoaded = createInventory(
      [createInstance(MODEL_KEY, LYS_IDENTIFIER)],
      []
    )
    const stop = vi.fn<StopLoadedLlmModelInstance>(async () => undefined)
    const record = createSavedRecord(LYS_IDENTIFIER, OTHER_LYS_IDENTIFIER)

    await stopRequestedModel(listLoaded, stop, record)

    expect(record.listSavedIdentifierSets()).toEqual([new Set()])
  })

  it("returns not-loaded with a diagnostic, stopping and saving nothing, when the record cannot be read", async () => {
    const listLoaded = createInventory([
      createInstance(MODEL_KEY, LYS_IDENTIFIER)
    ])
    const stop = vi.fn<StopLoadedLlmModelInstance>()
    const record = new InMemoryLysLlmInstanceStore({
      status: "unreadable",
      message: "The loaded models file is not JSON."
    })

    const outcome = await stopRequestedModel(listLoaded, stop, record)

    expect(outcome).toEqual({
      status: "not-loaded",
      diagnostics: [
        {
          operation: "read-lys-instance-identifiers",
          message: "The loaded models file is not JSON."
        }
      ]
    })
    expect(stop).not.toHaveBeenCalled()
    expect(record.listSavedIdentifierSets()).toEqual([])
  })

  it("returns stopped with a diagnostic when the record cannot be saved after the stops", async () => {
    const listLoaded = createInventory(
      [createInstance(MODEL_KEY, LYS_IDENTIFIER)],
      []
    )
    const stop = vi.fn<StopLoadedLlmModelInstance>(async () => undefined)
    const record = createSavedRecord(LYS_IDENTIFIER)
    record.failSaves(new Error("disk full"))

    const outcome = await stopRequestedModel(listLoaded, stop, record)

    expect(outcome).toEqual({
      status: "stopped",
      diagnostics: [
        { operation: "save-lys-instance-identifiers", message: "disk full" }
      ]
    })
  })

  it("returns runtime-unavailable without stopping or saving when the initial inventory fails", async () => {
    const listLoaded = vi.fn<ListLoadedLlmModelInstances>(async () => {
      throw new Error("socket closed")
    })
    const stop = vi.fn<StopLoadedLlmModelInstance>()
    const record = createSavedRecord(LYS_IDENTIFIER)

    const outcome = await stopRequestedModel(listLoaded, stop, record)

    expect(outcome).toEqual({
      status: "runtime-unavailable",
      diagnostics: [
        { operation: "list-initial-model-instances", message: "socket closed" }
      ]
    })
    expect(stop).not.toHaveBeenCalled()
    expect(record.listSavedIdentifierSets()).toEqual([])
  })

  it("returns runtime-unavailable with stop failures, saving nothing, when reconciliation fails", async () => {
    const listLoaded = vi
      .fn<ListLoadedLlmModelInstances>()
      .mockResolvedValueOnce([
        createInstance(MODEL_KEY, LYS_IDENTIFIER),
        createInstance(MODEL_KEY, SECOND_LYS_IDENTIFIER)
      ])
      .mockRejectedValueOnce(new Error("socket closed"))
    const stop = vi.fn<StopLoadedLlmModelInstance>(async (identifier) => {
      if (identifier === SECOND_LYS_IDENTIFIER) {
        throw new Error("refused")
      }
    })
    const record = createSavedRecord(LYS_IDENTIFIER, SECOND_LYS_IDENTIFIER)

    const outcome = await stopRequestedModel(listLoaded, stop, record)

    expect(outcome).toEqual({
      status: "runtime-unavailable",
      diagnostics: [
        {
          operation: "stop-model-instance",
          modelIdentifier: SECOND_LYS_IDENTIFIER,
          message: "refused"
        },
        {
          operation: "list-reconciled-model-instances",
          message: "socket closed"
        }
      ]
    })
    expect(record.listSavedIdentifierSets()).toEqual([])
  })

  it.each([
    ["a non-error value", "offline"],
    ["an error without a message", new Error("")]
  ])(
    "summarizes %s with a non-empty failure message",
    async (_label, rejection) => {
      const listLoaded = vi.fn<ListLoadedLlmModelInstances>(async () => {
        throw rejection
      })

      const outcome = await stopRequestedModel(
        listLoaded,
        vi.fn(),
        createSavedRecord()
      )

      expect(outcome.diagnostics).toEqual([
        {
          operation: "list-initial-model-instances",
          message: expect.stringMatching(/\S/)
        }
      ])
    }
  )

  it("returns a transitively frozen outcome", async () => {
    const listLoaded = createInventory(
      [createInstance(MODEL_KEY, LYS_IDENTIFIER)],
      [createInstance(MODEL_KEY, LYS_IDENTIFIER)]
    )
    const stop = vi.fn<StopLoadedLlmModelInstance>(async () => {
      throw new Error("refused")
    })

    const outcome = await stopRequestedModel(
      listLoaded,
      stop,
      createSavedRecord(LYS_IDENTIFIER)
    )

    expect(outcome.status).toBe("stop-failed")
    expect(Object.isFrozen(outcome)).toBe(true)
    expect(Object.isFrozen(outcome.diagnostics)).toBe(true)
    expect(Object.isFrozen(outcome.diagnostics[0])).toBe(true)
    if (outcome.status === "stop-failed") {
      expect(Object.isFrozen(outcome.remainingModelIdentifiers)).toBe(true)
    }
  })
})
