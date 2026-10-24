import { describe, expect, it } from "vitest"
import InMemoryLysLlmInstanceStore from "../../support/inMemoryLysLlmInstanceStore"
import { registerLysLlmInstanceStoreContractSuite } from "../../support/lysLlmInstanceStoreContract"

describe("InMemoryLysLlmInstanceStore", () => {
  registerLysLlmInstanceStoreContractSuite(() =>
    Promise.resolve(new InMemoryLysLlmInstanceStore())
  )

  it("keeps the record and records no save while saves fail", async () => {
    const store = new InMemoryLysLlmInstanceStore()
    await store.saveLysLlmInstanceIdentifiers(new Set(["a@lys-000001"]))
    const saveFailure = new Error("disk full")
    store.failSaves(saveFailure)

    await expect(store.saveLysLlmInstanceIdentifiers(new Set())).rejects.toBe(
      saveFailure
    )

    await expect(store.readLysLlmInstanceIdentifiers()).resolves.toEqual({
      status: "read",
      instanceIdentifiers: new Set(["a@lys-000001"])
    })
    expect(store.listSavedIdentifierSets()).toEqual([new Set(["a@lys-000001"])])
  })

  it("reads an unreadable record it was created with", async () => {
    const store = new InMemoryLysLlmInstanceStore({
      status: "unreadable",
      message: "The loaded models file is not JSON."
    })

    await expect(store.readLysLlmInstanceIdentifiers()).resolves.toEqual({
      status: "unreadable",
      message: "The loaded models file is not JSON."
    })
  })
})
