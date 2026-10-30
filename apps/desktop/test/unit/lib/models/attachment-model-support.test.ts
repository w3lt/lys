import { describe, expect, it } from "vitest"
import { calculateAttachmentModelSupport } from "@/lib/models/attachment-model-support"
import type {
  ModelInventoryState,
  ModelRuntimeState
} from "@/lib/store/model-runtime"
import { buildLlmInfo } from "../../support/modelFixtures"

/** Inventory listing one model that sees images and calls tools, and one that does neither. */
const INVENTORY: ModelInventoryState = {
  status: "ready",
  modelLoading: "lys",
  models: [
    buildLlmInfo("capable", {
      loaded: true,
      vision: true,
      trainedForToolUse: true
    }),
    buildLlmInfo("plain", {
      loaded: true,
      vision: false,
      trainedForToolUse: false
    })
  ]
}

describe("calculateAttachmentModelSupport", () => {
  it("says whether the loaded model has vision and was trained for tool use", () => {
    expect(
      calculateAttachmentModelSupport(
        { status: "loaded", modelKey: "capable" },
        INVENTORY
      )
    ).toEqual({ vision: true, trainedForToolUse: true })
    expect(
      calculateAttachmentModelSupport(
        { status: "loaded", modelKey: "plain" },
        INVENTORY
      )
    ).toEqual({ vision: false, trainedForToolUse: false })
  })

  it.each<[string, ModelRuntimeState, ModelInventoryState]>([
    ["no model is loaded", { status: "none" }, INVENTORY],
    [
      "a model is still loading",
      { status: "loading", modelKey: "capable" },
      INVENTORY
    ],
    [
      "the inventory was not read",
      { status: "loaded", modelKey: "capable" },
      { status: "unavailable" }
    ],
    [
      "the inventory does not list the loaded model",
      { status: "loaded", modelKey: "other" },
      INVENTORY
    ]
  ])("is unknown when %s", (_case, modelRuntime, inventory) => {
    expect(
      calculateAttachmentModelSupport(modelRuntime, inventory)
    ).toBeUndefined()
  })
})
