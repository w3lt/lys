import { describe, expect, it } from "vitest"
import {
  buildModelRuntime,
  isModelTransitionInFlight,
  type ModelInventoryState,
  type ModelRuntimeState
} from "@/lib/store/model-runtime"
import { buildLlmInfo } from "../../support/modelFixtures"

/** Inventory listing two resident models and one on disk, in that order. */
const TWO_RESIDENT: ModelInventoryState = {
  status: "ready",
  models: [
    buildLlmInfo("first", { loaded: true }),
    buildLlmInfo("on-disk"),
    buildLlmInfo("second", { loaded: true })
  ]
}

describe("buildModelRuntime", () => {
  it.each(["loading", "unloading"] as const)(
    "reports a %s request as the transition, whatever the inventory says",
    (status) => {
      expect(
        buildModelRuntime(
          { status: "failed" },
          { status, modelKey: "on-disk" },
          null
        )
      ).toEqual({ status, modelKey: "on-disk" })
    }
  )

  it("prefers the loaded default model", () => {
    expect(
      buildModelRuntime(TWO_RESIDENT, { status: "idle" }, "second")
    ).toEqual({
      status: "loaded",
      modelKey: "second"
    })
  })

  it("falls back to the first loaded model when the default is not loaded", () => {
    expect(
      buildModelRuntime(TWO_RESIDENT, { status: "idle" }, "on-disk")
    ).toEqual({
      status: "loaded",
      modelKey: "first"
    })
  })

  it("reports no resident weights when the inventory has none loaded", () => {
    const inventory: ModelInventoryState = {
      status: "ready",
      models: [buildLlmInfo("on-disk")]
    }

    expect(buildModelRuntime(inventory, { status: "idle" }, "on-disk")).toEqual(
      {
        status: "none"
      }
    )
  })

  it("reports residency as unknown after a failed observation, not as empty", () => {
    expect(
      buildModelRuntime({ status: "failed" }, { status: "idle" }, null)
    ).toEqual({
      status: "unknown"
    })
  })

  it("reports no resident weights before any observation", () => {
    expect(
      buildModelRuntime({ status: "unavailable" }, { status: "idle" }, null)
    ).toEqual({ status: "none" })
  })

  it.each(["listing", "testing"] as const)(
    "keeps the observed residency during a %s request",
    (status) => {
      const request =
        status === "listing" ? { status } : { status, modelKey: "second" }

      expect(buildModelRuntime(TWO_RESIDENT, request, null)).toEqual({
        status: "loaded",
        modelKey: "first"
      })
    }
  )
})

describe("isModelTransitionInFlight", () => {
  it.each<[ModelRuntimeState, boolean]>([
    [{ status: "loading", modelKey: "x" }, true],
    [{ status: "unloading", modelKey: "x" }, true],
    [{ status: "loaded", modelKey: "x" }, false],
    [{ status: "none" }, false],
    [{ status: "unknown" }, false]
  ])("answers %o with %s", (modelRuntime, isInFlight) => {
    expect(isModelTransitionInFlight(modelRuntime)).toBe(isInFlight)
  })
})
