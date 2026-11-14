import { describe, expect, it } from "vitest"
import { calculateAttachmentModelSupport } from "@/lib/models/attachment-model-support"
import { buildLlmInfo } from "../../support/modelFixtures"

describe("calculateAttachmentModelSupport", () => {
  it("says whether the loaded model has vision and was trained for tool use", () => {
    expect(
      calculateAttachmentModelSupport(
        buildLlmInfo("capable", {
          loaded: true,
          vision: true,
          trainedForToolUse: true
        })
      )
    ).toEqual({ vision: true, trainedForToolUse: true })
    expect(
      calculateAttachmentModelSupport(
        buildLlmInfo("plain", {
          loaded: true,
          vision: false,
          trainedForToolUse: false
        })
      )
    ).toEqual({ vision: false, trainedForToolUse: false })
  })

  it("is unknown without a loaded model", () => {
    expect(calculateAttachmentModelSupport(undefined)).toBeUndefined()
  })
})
