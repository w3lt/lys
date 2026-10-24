import { describe, expect, it } from "vitest"
import type { LysLlmInstanceStore } from "../../../src/modules/llm/lysLlmInstanceStore"

/**
 * Creates one store over a record nothing was saved to, owned by the current
 * test, which releases whatever it needs when it finishes.
 */
export type LysLlmInstanceStoreFactory = () => Promise<LysLlmInstanceStore>

/** Identifier of an instance Lys loaded, as the service builds one. */
const FIRST_IDENTIFIER = "a/model@lys-000001"

/** Identifier of a second instance, of another model. */
const SECOND_IDENTIFIER = "b/model@lys-000002"

/**
 * Registers the implementation-independent {@link LysLlmInstanceStore}
 * contract cases.
 *
 * @param createStore - Creates a store over an empty record per case.
 */
export function registerLysLlmInstanceStoreContractSuite(
  createStore: LysLlmInstanceStoreFactory
): void {
  describe("LysLlmInstanceStore contract", () => {
    it("reads no identifier before anything is saved", async () => {
      const store = await createStore()

      await expect(store.readLysLlmInstanceIdentifiers()).resolves.toEqual({
        status: "read",
        instanceIdentifiers: new Set()
      })
    })

    it("reads exactly the identifiers last saved", async () => {
      const store = await createStore()

      await store.saveLysLlmInstanceIdentifiers(
        new Set([SECOND_IDENTIFIER, FIRST_IDENTIFIER])
      )

      await expect(store.readLysLlmInstanceIdentifiers()).resolves.toEqual({
        status: "read",
        instanceIdentifiers: new Set([FIRST_IDENTIFIER, SECOND_IDENTIFIER])
      })
    })

    it("replaces the whole record on each save", async () => {
      const store = await createStore()
      await store.saveLysLlmInstanceIdentifiers(
        new Set([FIRST_IDENTIFIER, SECOND_IDENTIFIER])
      )

      await store.saveLysLlmInstanceIdentifiers(new Set([SECOND_IDENTIFIER]))

      await expect(store.readLysLlmInstanceIdentifiers()).resolves.toEqual({
        status: "read",
        instanceIdentifiers: new Set([SECOND_IDENTIFIER])
      })
    })

    it("keeps no identifier after an empty set is saved", async () => {
      const store = await createStore()
      await store.saveLysLlmInstanceIdentifiers(new Set([FIRST_IDENTIFIER]))

      await store.saveLysLlmInstanceIdentifiers(new Set())

      await expect(store.readLysLlmInstanceIdentifiers()).resolves.toEqual({
        status: "read",
        instanceIdentifiers: new Set()
      })
    })

    it("keeps what was saved when the caller later changes its set", async () => {
      const store = await createStore()
      const instanceIdentifiers = new Set([FIRST_IDENTIFIER])
      await store.saveLysLlmInstanceIdentifiers(instanceIdentifiers)

      instanceIdentifiers.add(SECOND_IDENTIFIER)

      await expect(store.readLysLlmInstanceIdentifiers()).resolves.toEqual({
        status: "read",
        instanceIdentifiers: new Set([FIRST_IDENTIFIER])
      })
    })

    it("hands each read a set of its own", async () => {
      const store = await createStore()
      const savedIdentifiers = new Set([FIRST_IDENTIFIER])
      await store.saveLysLlmInstanceIdentifiers(savedIdentifiers)

      const firstRead = await store.readLysLlmInstanceIdentifiers()
      const secondRead = await store.readLysLlmInstanceIdentifiers()

      if (firstRead.status !== "read" || secondRead.status !== "read") {
        throw new Error("Expected both reads to succeed")
      }
      expect(firstRead.instanceIdentifiers).not.toBe(savedIdentifiers)
      expect(firstRead.instanceIdentifiers).not.toBe(
        secondRead.instanceIdentifiers
      )
    })
  })
}
