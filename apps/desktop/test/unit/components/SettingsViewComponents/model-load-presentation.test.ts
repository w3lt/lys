import { describe, expect, it } from "vitest"
import {
  buildLoadSettingsWithBaseline,
  formatModelLoadChangeNote,
  parseEvalBatchSize
} from "@/components/SettingsViewComponents/model-load-presentation"
import { buildModelLoadConfiguration } from "@/lib/models/model-load-configuration"
import type { CompleteModelLoadConfiguration } from "@/lib/store/settings"
import { FIRST_RUN_LOAD_CONFIGURATION } from "../../support/settingsFixtures"

/** Settings a model ran with before the change. */
const BASELINE: CompleteModelLoadConfiguration = FIRST_RUN_LOAD_CONFIGURATION

/** Settings that differ from {@link BASELINE} in the flash attention. */
const CHANGED: CompleteModelLoadConfiguration = Object.freeze({
  ...BASELINE,
  flashAttention: !BASELINE.flashAttention
})

describe("formatModelLoadChangeNote", () => {
  it("says nothing while the stored settings equal the baseline", () => {
    expect(
      formatModelLoadChangeNote("qwen3-8b", true, BASELINE, { ...BASELINE })
    ).toBeNull()
  })

  it("asks to reload a loaded model to apply a change", () => {
    expect(formatModelLoadChangeNote("qwen3-8b", true, BASELINE, CHANGED)).toBe(
      "Saved. Reload qwen3-8b to apply it."
    )
  })

  it("says a change applies when a model that is not loaded is loaded", () => {
    expect(
      formatModelLoadChangeNote("qwen3-8b", false, BASELINE, CHANGED)
    ).toBe("Saved. Applies when you load it.")
  })
})

describe("buildLoadSettingsWithBaseline", () => {
  it("gives the model the baseline back without an expert count of its own when the baseline has none", () => {
    const changed = {
      default: {},
      models: new Map([["qwen3-8b", { flashAttention: false, numExperts: 4 }]])
    }

    const restored = buildLoadSettingsWithBaseline(
      changed,
      "qwen3-8b",
      BASELINE
    )

    expect(
      buildModelLoadConfiguration(restored, {
        modelKey: "qwen3-8b",
        maxContextLength: null
      })
    ).toEqual(BASELINE)
    expect(restored.models.get("qwen3-8b")).not.toHaveProperty("numExperts")
  })

  it("gives the model the baseline's expert count back", () => {
    const restored = buildLoadSettingsWithBaseline(
      { default: {}, models: new Map() },
      "qwen3-8b",
      { ...BASELINE, numExperts: 2 }
    )

    expect(restored.models.get("qwen3-8b")).toMatchObject({ numExperts: 2 })
  })

  it("leaves other models' settings as they are", () => {
    const other = { evalBatchSize: 256 }

    const restored = buildLoadSettingsWithBaseline(
      { default: {}, models: new Map([["gemma-3", other]]) },
      "qwen3-8b",
      BASELINE
    )

    expect(restored.models.get("gemma-3")).toEqual(other)
  })
})

describe("parseEvalBatchSize", () => {
  it.each([
    ["1", 1],
    ["512", 512],
    [" 8192 ", 8192]
  ])("accepts %s", (text, size) => {
    expect(parseEvalBatchSize(text)).toBe(size)
  })

  it.each(["", "0", "8193", "1.5", "-4", "abc", "1e3"])(
    "rejects %j",
    (text) => {
      expect(parseEvalBatchSize(text)).toBeNull()
    }
  )
})
