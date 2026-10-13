import { describe, expect, it } from "vitest"
import {
  buildModelReloadPrompt,
  findLoadedSettingValue,
  formatContextLengthNote,
  formatLoadConfigurationEmptyMessage,
  isModelResidencyChanging,
  type ModelReloadPrompt
} from "@/components/SettingsViewComponents/model-load-presentation"
import type { ModelRequestState } from "@/lib/store/model-runtime"
import type { CompleteModelLoadConfiguration } from "@/lib/store/settings"
import { FIRST_RUN_LOAD_CONFIGURATION } from "../../support/settingsFixtures"

/** Configuration the model would be loaded with now. */
const STORED: CompleteModelLoadConfiguration = FIRST_RUN_LOAD_CONFIGURATION

/** Configuration the model runs with: a smaller context and no flash attention. */
const LOADED: CompleteModelLoadConfiguration = Object.freeze({
  ...FIRST_RUN_LOAD_CONFIGURATION,
  contextLength: 4096,
  flashAttention: false
})

describe("isModelResidencyChanging", () => {
  it.each(["loading", "unloading"] as const)(
    "is true while the model itself is %s",
    (status) => {
      expect(
        isModelResidencyChanging({ status, modelKey: "qwen3-8b" }, "qwen3-8b")
      ).toBe(true)
    }
  )

  it.each<ModelRequestState>([
    { status: "loading", modelKey: "gemma-3" },
    { status: "unloading", modelKey: "gemma-3" },
    { status: "testing", modelKey: "qwen3-8b" },
    { status: "listing" },
    { status: "idle" }
  ])("is false for the request %o", (modelRequest) => {
    expect(isModelResidencyChanging(modelRequest, "qwen3-8b")).toBe(false)
  })
})

describe("buildModelReloadPrompt", () => {
  it("says nothing when nothing is known about the loaded model", () => {
    expect(buildModelReloadPrompt(undefined, STORED)).toBeNull()
  })

  it.each(["sent", "assumed"] as const)(
    "says nothing when the %s configuration equals the stored one",
    (origin) => {
      expect(
        buildModelReloadPrompt({ origin, configuration: { ...STORED } }, STORED)
      ).toBeNull()
    }
  )

  it("lists what a model Lys loaded runs with and what a reload would apply", () => {
    expect(
      buildModelReloadPrompt({ origin: "sent", configuration: LOADED }, STORED)
    ).toEqual({
      note: "loaded with ctx 4k, flash attn off · reload to apply ctx 8k, flash attn on",
      differences: [
        {
          setting: "contextLength",
          loadedValue: "4k",
          loadedPhrase: "ctx 4k",
          storedPhrase: "ctx 8k"
        },
        {
          setting: "flashAttention",
          loadedValue: "off",
          loadedPhrase: "flash attn off",
          storedPhrase: "flash attn on"
        }
      ]
    })
  })

  it("claims no loaded values for a model found already loaded, only that changes wait for the next load", () => {
    expect(
      buildModelReloadPrompt(
        { origin: "assumed", configuration: LOADED },
        STORED
      )
    ).toEqual({
      note: "Changes apply the next time this model loads.",
      differences: []
    })
  })
})

describe("findLoadedSettingValue", () => {
  /** Prompt of a model Lys loaded with {@link LOADED}. */
  const sentPrompt: ModelReloadPrompt | null = buildModelReloadPrompt(
    { origin: "sent", configuration: LOADED },
    STORED
  )

  it("finds the value a differing setting was loaded with", () => {
    expect(findLoadedSettingValue(sentPrompt, "contextLength")).toBe("4k")
    expect(findLoadedSettingValue(sentPrompt, "flashAttention")).toBe("off")
  })

  it("finds nothing for a setting that does not differ", () => {
    expect(findLoadedSettingValue(sentPrompt, "evalBatchSize")).toBeNull()
  })

  it("finds nothing without a reload prompt", () => {
    expect(findLoadedSettingValue(null, "contextLength")).toBeNull()
  })

  it("finds nothing when the loaded values are only assumed", () => {
    const assumedPrompt = buildModelReloadPrompt(
      { origin: "assumed", configuration: LOADED },
      STORED
    )

    expect(findLoadedSettingValue(assumedPrompt, "contextLength")).toBeNull()
  })
})

describe("formatContextLengthNote", () => {
  it("names the model's maximum when the runtime reports one", () => {
    expect(formatContextLengthNote("qwen3-8b", "8k")).toBe(
      "Tokens the weights can hold at once. qwen3-8b tops out at 8k."
    )
  })

  it("leaves the maximum out when none is known", () => {
    expect(formatContextLengthNote("qwen3-8b", null)).toBe(
      "Tokens the weights can hold at once."
    )
  })
})

describe("formatLoadConfigurationEmptyMessage", () => {
  it("asks for a default model once the models are listed", () => {
    expect(formatLoadConfigurationEmptyMessage("ready")).toBe(
      "Choose a default model above to edit its load configuration."
    )
  })

  it.each(["unavailable", "failed"] as const)(
    "says the model list is needed while the inventory is %s",
    (status) => {
      expect(formatLoadConfigurationEmptyMessage(status)).toBe(
        "Load configurations can be edited once the models are listed."
      )
    }
  )
})
