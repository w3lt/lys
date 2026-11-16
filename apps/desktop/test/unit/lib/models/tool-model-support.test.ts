import { describe, expect, it } from "vitest"
import { calculateToolModelSupport } from "@/lib/models/tool-model-support"
import { buildLlmInfo } from "../../support/modelFixtures"

describe("calculateToolModelSupport", () => {
  it("says whether the loaded model was trained for tools", () => {
    expect(
      calculateToolModelSupport(
        buildLlmInfo("trained", { loaded: true, trainedForToolUse: true })
      )
    ).toEqual({ status: "trained", modelKey: "trained" })
    expect(
      calculateToolModelSupport(
        buildLlmInfo("untrained", { loaded: true, trainedForToolUse: false })
      )
    ).toEqual({ status: "untrained", modelKey: "untrained" })
  })

  it("is unknown without a loaded model", () => {
    expect(calculateToolModelSupport(undefined)).toEqual({ status: "unknown" })
  })
})
