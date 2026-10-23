import { describe, expect, it } from "vitest"
import {
  buildLysLlmInstanceIdentifier,
  calculateLysLlmInstanceIdentifierOrder,
  createRandomLysInstanceSuffix,
  findLoadedLysLlmInstanceIdentifiers
} from "../../../../src/modules/llm/lysLlmInstanceIdentifiers"

describe("buildLysLlmInstanceIdentifier", () => {
  it("joins the requested model and the random part with @lys-", () => {
    expect(buildLysLlmInstanceIdentifier("qwen/qwen3-8b", "7f3c9a")).toBe(
      "qwen/qwen3-8b@lys-7f3c9a"
    )
  })
})

describe("createRandomLysInstanceSuffix", () => {
  it("creates six lowercase hex digits", () => {
    expect(createRandomLysInstanceSuffix()).toMatch(/^[0-9a-f]{6}$/)
  })
})

describe("calculateLysLlmInstanceIdentifierOrder", () => {
  it("orders identifiers by code unit, uppercase before lowercase, in every locale", () => {
    expect(
      ["b@lys-000001", "a@lys-000002", "B@lys-000003", "a@lys-000001"].toSorted(
        calculateLysLlmInstanceIdentifierOrder
      )
    ).toEqual(["B@lys-000003", "a@lys-000001", "a@lys-000002", "b@lys-000001"])
  })

  it("returns zero for equal identifiers", () => {
    expect(
      calculateLysLlmInstanceIdentifierOrder("a@lys-000001", "a@lys-000001")
    ).toBe(0)
  })
})

describe("findLoadedLysLlmInstanceIdentifiers", () => {
  it("keeps only the saved identifiers some loaded instance has", () => {
    const loaded = findLoadedLysLlmInstanceIdentifiers(
      new Set(["a/model@lys-000001", "a/model@lys-000002"]),
      [
        { modelKey: "a/model", modelIdentifier: "a/model" },
        { modelKey: "a/model", modelIdentifier: "a/model@lys-000002" }
      ]
    )

    expect(loaded).toEqual(new Set(["a/model@lys-000002"]))
  })
})
