import { llmInfoSchema } from "@lys/protocol"
import { describe, expect, it } from "vitest"
import { buildModelDescriptor } from "@/lib/models/inventory"
import { buildLlmInfo } from "../../support/modelFixtures"

describe("buildModelDescriptor", () => {
  it("joins parameters, quantization, and disk size into the detail line", () => {
    const model = buildLlmInfo("qwen3-8b")

    expect(buildModelDescriptor(model)).toEqual({
      ...model,
      detail: "7B · Q4_K_M · 4.0 GB",
      sizeLabel: "4.0 GB"
    })
  })

  it("leaves metadata the backend did not report out of the detail line", () => {
    const model = llmInfoSchema.parse({
      modelKey: "bare-model",
      format: "gguf",
      displayName: "Bare model",
      path: "publisher/bare-model/bare-model.gguf",
      sizeBytes: 12_345_678_901,
      vision: false,
      trainedForToolUse: false,
      maxContextLength: 4096,
      loaded: false
    })

    expect(buildModelDescriptor(model)).toMatchObject({
      detail: "12.3 GB",
      sizeLabel: "12.3 GB"
    })
  })

  it("measures size in decimal gigabytes", () => {
    const model = llmInfoSchema.parse({
      ...buildLlmInfo("binary-sized"),
      sizeBytes: 1_073_741_824
    })

    expect(buildModelDescriptor(model).sizeLabel).toBe("1.1 GB")
  })
})
