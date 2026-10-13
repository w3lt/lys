import { describe, expect, it } from "vitest"
import { calculateToolModelSupport } from "@/lib/models/tool-model-support"
import type {
  ModelInventoryState,
  ModelRuntimeState
} from "@/lib/store/model-runtime"
import { buildLlmInfo } from "../../support/modelFixtures"

/** Inventory listing one model trained for tools and one that is not. */
const INVENTORY: ModelInventoryState = {
  status: "ready",
  models: [
    buildLlmInfo("trained", { loaded: true, trainedForToolUse: true }),
    buildLlmInfo("untrained", { loaded: true, trainedForToolUse: false })
  ]
}

describe("calculateToolModelSupport", () => {
  it("says whether the loaded model was trained for tools", () => {
    expect(
      calculateToolModelSupport(
        { status: "loaded", modelKey: "trained" },
        INVENTORY
      )
    ).toEqual({ status: "trained", modelKey: "trained" })
    expect(
      calculateToolModelSupport(
        { status: "loaded", modelKey: "untrained" },
        INVENTORY
      )
    ).toEqual({ status: "untrained", modelKey: "untrained" })
  })

  it.each<[string, ModelRuntimeState, ModelInventoryState]>([
    ["no model is loaded", { status: "none" }, INVENTORY],
    ["the residency is unknown", { status: "unknown" }, INVENTORY],
    [
      "a model is still loading",
      { status: "loading", modelKey: "trained" },
      INVENTORY
    ],
    [
      "the model is being unloaded",
      { status: "unloading", modelKey: "trained" },
      INVENTORY
    ],
    [
      "the inventory was not read",
      { status: "loaded", modelKey: "trained" },
      { status: "unavailable" }
    ],
    [
      "the inventory failed",
      { status: "loaded", modelKey: "trained" },
      { status: "failed" }
    ],
    [
      "the inventory does not list the loaded model",
      { status: "loaded", modelKey: "other" },
      INVENTORY
    ]
  ])("is unknown when %s", (_case, modelRuntime, inventory) => {
    expect(calculateToolModelSupport(modelRuntime, inventory)).toEqual({
      status: "unknown"
    })
  })
})
