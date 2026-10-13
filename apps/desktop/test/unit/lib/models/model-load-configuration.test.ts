import {
  MAXIMUM_MODEL_LOAD_SETTING_VALUE,
  type ModelLoadConfiguration
} from "@lys/share"
import { describe, expect, it } from "vitest"
import {
  buildDefaultModelLoadConfiguration,
  buildLoadConfigurationSettings,
  buildModelLoadConfiguration,
  calculateContextLength,
  calculateContextLengthStopIndex,
  findLoadConfigurationTarget,
  formatModelLoadSetting,
  formatModelReloadNote,
  formatTokenCount,
  isLoadConfigurationSettingsEqual,
  isModelLoadConfigurationEqual,
  isUsableContextLimit,
  listContextLengthStops,
  listModelLoadDifferences
} from "@/lib/models/model-load-configuration"
import type {
  CompleteModelLoadConfiguration,
  LoadConfigurationSettings
} from "@/lib/store/settings"
import { FIRST_RUN_LOAD_CONFIGURATION } from "../../support/settingsFixtures"

/** Maximum context lengths that cannot bound a setting. */
const UNUSABLE_CONTEXT_LIMITS = [
  0,
  -4096,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY
]

/**
 * Builds stored load settings.
 *
 * @param storedDefault - Settings the settings file sets for every model;
 * none by default, as in a first-run file.
 * @param models - Settings each model has of its own, by model key.
 * @returns The settings, with the per-model settings as a map.
 */
function buildLoadSettings(
  storedDefault: ModelLoadConfiguration = {},
  models: Readonly<Record<string, ModelLoadConfiguration>> = {}
): LoadConfigurationSettings {
  return { default: storedDefault, models: new Map(Object.entries(models)) }
}

/**
 * Lists the model entries of stored load settings as plain data.
 *
 * @param settings - Stored load settings.
 * @returns The per-model settings as one object keyed by model key.
 */
function listOwnSettings(
  settings: LoadConfigurationSettings
): Record<string, ModelLoadConfiguration> {
  return Object.fromEntries(settings.models)
}

describe("buildDefaultModelLoadConfiguration", () => {
  it("takes every setting from the committed default when the settings file sets none", () => {
    const configuration =
      buildDefaultModelLoadConfiguration(buildLoadSettings())

    expect(configuration).toEqual(FIRST_RUN_LOAD_CONFIGURATION)
    expect(configuration).not.toHaveProperty("numExperts")
  })

  it("prefers each setting the settings file's default sets, a false one included", () => {
    const settings = buildLoadSettings({
      contextLength: 16_384,
      flashAttention: false,
      numExperts: 4
    })

    expect(buildDefaultModelLoadConfiguration(settings)).toEqual({
      contextLength: 16_384,
      evalBatchSize: 512,
      flashAttention: false,
      offloadKVCacheToGpu: true,
      numExperts: 4
    })
  })

  it("ignores the settings models have of their own", () => {
    const settings = buildLoadSettings(
      {},
      { "qwen3-8b": { evalBatchSize: 64 } }
    )

    expect(buildDefaultModelLoadConfiguration(settings)).toEqual(
      FIRST_RUN_LOAD_CONFIGURATION
    )
  })
})

describe("buildModelLoadConfiguration", () => {
  it("takes each setting from the model's own settings, then the stored default, then the committed default", () => {
    const settings = buildLoadSettings(
      { contextLength: 16_384, evalBatchSize: 256 },
      { "qwen3-8b": { evalBatchSize: 1024, offloadKVCacheToGpu: false } }
    )

    expect(
      buildModelLoadConfiguration(settings, {
        modelKey: "qwen3-8b",
        maxContextLength: 32_768
      })
    ).toEqual({
      contextLength: 16_384,
      evalBatchSize: 1024,
      flashAttention: true,
      offloadKVCacheToGpu: false
    })
  })

  it("gives a model with no settings of its own the default configuration", () => {
    const settings = buildLoadSettings(
      { evalBatchSize: 256 },
      { "qwen3-8b": { evalBatchSize: 1024 } }
    )

    expect(
      buildModelLoadConfiguration(settings, {
        modelKey: "gemma-3",
        maxContextLength: 32_768
      })
    ).toEqual({
      contextLength: 8192,
      evalBatchSize: 256,
      flashAttention: true,
      offloadKVCacheToGpu: true
    })
  })

  it.each([
    ["the model's own count", { numExperts: 2 }, { numExperts: 6 }, 6],
    ["the stored default's count", { numExperts: 2 }, {}, 2]
  ])("loads with %s of experts", (_label, storedDefault, own, numExperts) => {
    const settings = buildLoadSettings(storedDefault, { "qwen3-8b": own })

    expect(
      buildModelLoadConfiguration(settings, {
        modelKey: "qwen3-8b",
        maxContextLength: 8192
      })
    ).toHaveProperty("numExperts", numExperts)
  })

  it("leaves the expert count out when neither the model nor a default sets one", () => {
    const settings = buildLoadSettings(
      {},
      { "qwen3-8b": { evalBatchSize: 64 } }
    )

    expect(
      buildModelLoadConfiguration(settings, {
        modelKey: "qwen3-8b",
        maxContextLength: 8192
      })
    ).not.toHaveProperty("numExperts")
  })

  it.each([
    [16_384, 8192, 8192],
    [8192, 8192, 8192],
    [4096, 8192, 4096]
  ])(
    "loads a context length of %d into a model that tops out at %d as %d",
    (contextLength, maxContextLength, loadedContextLength) => {
      const settings = buildLoadSettings({}, { "qwen3-8b": { contextLength } })

      expect(
        buildModelLoadConfiguration(settings, {
          modelKey: "qwen3-8b",
          maxContextLength
        }).contextLength
      ).toBe(loadedContextLength)
    }
  )

  it.each([null, ...UNUSABLE_CONTEXT_LIMITS])(
    "keeps the configured context length when the model's maximum is %o",
    (maxContextLength) => {
      const settings = buildLoadSettings({ contextLength: 16_384 })

      expect(
        buildModelLoadConfiguration(settings, {
          modelKey: "qwen3-8b",
          maxContextLength
        }).contextLength
      ).toBe(16_384)
    }
  )
})

describe("buildLoadConfigurationSettings", () => {
  it("gives a model its first own settings, holding only what was assigned", () => {
    const settings = buildLoadConfigurationSettings(buildLoadSettings(), {
      kind: "assignment",
      modelKey: "qwen3-8b",
      settings: { flashAttention: false }
    })

    expect(listOwnSettings(settings)).toEqual({
      "qwen3-8b": { flashAttention: false }
    })
  })

  it("replaces the assigned settings and keeps the model's others, the other models, and the default", () => {
    const before = buildLoadSettings(
      { contextLength: 16_384 },
      {
        "qwen3-8b": { evalBatchSize: 256, numExperts: 4 },
        "gemma-3": { flashAttention: false }
      }
    )

    const after = buildLoadConfigurationSettings(before, {
      kind: "assignment",
      modelKey: "qwen3-8b",
      settings: { evalBatchSize: 1024, offloadKVCacheToGpu: false }
    })

    expect(after.default).toEqual({ contextLength: 16_384 })
    expect(listOwnSettings(after)).toEqual({
      "qwen3-8b": {
        evalBatchSize: 1024,
        offloadKVCacheToGpu: false,
        numExperts: 4
      },
      "gemma-3": { flashAttention: false }
    })
  })

  it("leaves the settings it was given unchanged", () => {
    const before = buildLoadSettings({}, { "qwen3-8b": { evalBatchSize: 256 } })

    const after = buildLoadConfigurationSettings(before, {
      kind: "assignment",
      modelKey: "qwen3-8b",
      settings: { evalBatchSize: 1024 }
    })

    expect(listOwnSettings(before)).toEqual({
      "qwen3-8b": { evalBatchSize: 256 }
    })
    expect(after.models).not.toBe(before.models)
  })

  it("removes only the model's own expert count", () => {
    const before = buildLoadSettings(
      { numExperts: 2 },
      { "qwen3-8b": { evalBatchSize: 256, numExperts: 4 } }
    )

    const after = buildLoadConfigurationSettings(before, {
      kind: "expert-count-removal",
      modelKey: "qwen3-8b"
    })

    expect(after.default).toEqual({ numExperts: 2 })
    expect(listOwnSettings(after)).toEqual({
      "qwen3-8b": { evalBatchSize: 256 }
    })
    expect(after.models.get("qwen3-8b")).not.toHaveProperty("numExperts")
  })

  it("drops a model's entry once it would hold no setting", () => {
    const before = buildLoadSettings(
      {},
      { "qwen3-8b": { numExperts: 4 }, "gemma-3": { flashAttention: false } }
    )

    const after = buildLoadConfigurationSettings(before, {
      kind: "expert-count-removal",
      modelKey: "qwen3-8b"
    })

    expect(listOwnSettings(after)).toEqual({
      "gemma-3": { flashAttention: false }
    })
  })

  it.each([
    [
      "an expert count removal",
      { kind: "expert-count-removal", modelKey: "qwen3-8b" }
    ],
    [
      "an assignment of no setting",
      { kind: "assignment", modelKey: "qwen3-8b", settings: {} }
    ]
  ] as const)(
    "gives a model without settings of its own no entry after %s",
    (_label, change) => {
      const after = buildLoadConfigurationSettings(buildLoadSettings(), change)

      expect(after.models.size).toBe(0)
    }
  )

  it.each([
    [
      "an assignment",
      {
        kind: "assignment",
        modelKey: "qwen3-8b",
        settings: { contextLength: 4096, flashAttention: false }
      }
    ],
    [
      "an expert count removal",
      { kind: "expert-count-removal", modelKey: "qwen3-8b" }
    ]
  ] as const)(
    "gives the same settings when %s is applied twice",
    (_label, change) => {
      const before = buildLoadSettings(
        {},
        { "qwen3-8b": { evalBatchSize: 256, numExperts: 4 } }
      )

      const once = buildLoadConfigurationSettings(before, change)
      const twice = buildLoadConfigurationSettings(once, change)

      expect(listOwnSettings(twice)).toEqual(listOwnSettings(once))
    }
  )
})

describe("isModelLoadConfigurationEqual", () => {
  it("is true for the same settings, set or absent in both", () => {
    expect(
      isModelLoadConfigurationEqual(
        { contextLength: 4096, flashAttention: false },
        { flashAttention: false, contextLength: 4096 }
      )
    ).toBe(true)
  })

  it.each([
    [{ contextLength: 4096 }, { contextLength: 8192 }],
    [{ evalBatchSize: 256 }, { evalBatchSize: 512 }],
    [{ flashAttention: true }, { flashAttention: false }],
    [{ offloadKVCacheToGpu: true }, { offloadKVCacheToGpu: false }],
    [{ numExperts: 2 }, { numExperts: 4 }],
    [{ numExperts: 2 }, {}]
  ])("is false for %o and %o", (first, second) => {
    expect(isModelLoadConfigurationEqual(first, second)).toBe(false)
  })
})

describe("isLoadConfigurationSettingsEqual", () => {
  it("is true for equal defaults and equal model settings, whatever the order of the entries", () => {
    const first = buildLoadSettings(
      { contextLength: 16_384 },
      { "qwen3-8b": { evalBatchSize: 256 }, "gemma-3": { numExperts: 2 } }
    )
    const second = buildLoadSettings(
      { contextLength: 16_384 },
      { "gemma-3": { numExperts: 2 }, "qwen3-8b": { evalBatchSize: 256 } }
    )

    expect(isLoadConfigurationSettingsEqual(first, second)).toBe(true)
  })

  it.each([
    [
      "the defaults differ",
      buildLoadSettings({ contextLength: 8192 }, { a: { numExperts: 2 } })
    ],
    ["one has a model the other lacks", buildLoadSettings({}, {})],
    [
      "they hold settings for different models",
      buildLoadSettings({}, { b: { numExperts: 2 } })
    ],
    [
      "one model's settings differ",
      buildLoadSettings({}, { a: { numExperts: 4 } })
    ]
  ])("is false when %s", (_label, second) => {
    const first = buildLoadSettings({}, { a: { numExperts: 2 } })

    expect(isLoadConfigurationSettingsEqual(first, second)).toBe(false)
    expect(isLoadConfigurationSettingsEqual(second, first)).toBe(false)
  })
})

describe("isUsableContextLimit", () => {
  it.each([1, 2048, 131_072])("accepts %d tokens", (maxContextLength) => {
    expect(isUsableContextLimit(maxContextLength)).toBe(true)
  })

  it.each([null, ...UNUSABLE_CONTEXT_LIMITS])(
    "rejects %o",
    (maxContextLength) => {
      expect(isUsableContextLimit(maxContextLength)).toBe(false)
    }
  )
})

describe("listContextLengthStops", () => {
  it.each([
    [8192, [2048, 4096, 8192]],
    [10_000, [2048, 4096, 8192, 10_000]],
    [2049, [2048, 2049]],
    [2048, [2048]],
    [1000, [1000]],
    [1, [1]]
  ])("stops a model that tops out at %d at %o", (maxContextLength, stops) => {
    expect(listContextLengthStops(maxContextLength)).toEqual(stops)
  })

  it.each(UNUSABLE_CONTEXT_LIMITS)(
    "gives no stop for a maximum of %o",
    (maxContextLength) => {
      expect(listContextLengthStops(maxContextLength)).toEqual([])
    }
  )
})

describe("calculateContextLengthStopIndex", () => {
  it.each([
    [2048, 0],
    [4096, 1],
    [5000, 1],
    [8192, 2],
    [99_999, 2],
    [100, 0]
  ])(
    "shows a context length of %d at position %d of three stops",
    (contextLength, stopIndex) => {
      expect(
        calculateContextLengthStopIndex([2048, 4096, 8192], contextLength)
      ).toBe(stopIndex)
    }
  )
})

describe("calculateContextLength", () => {
  it.each([
    [4000, 8192, 4000],
    [512, 8192, 512],
    [511, 8192, 512],
    [8192, 8192, 8192],
    [8193, 8192, 8192],
    [100, 256, 100],
    [300, 256, 256],
    [0, 256, 1]
  ])(
    "commits %d typed tokens for a model that tops out at %d as %d",
    (typedTokens, maxContextLength, committed) => {
      expect(calculateContextLength(typedTokens, maxContextLength)).toBe(
        committed
      )
    }
  )

  it.each(UNUSABLE_CONTEXT_LIMITS)(
    "bounds a typed value by the largest accepted setting when the maximum is %o",
    (maxContextLength) => {
      expect(
        calculateContextLength(
          MAXIMUM_MODEL_LOAD_SETTING_VALUE + 1,
          maxContextLength
        )
      ).toBe(MAXIMUM_MODEL_LOAD_SETTING_VALUE)
      expect(calculateContextLength(100, maxContextLength)).toBe(512)
    }
  )
})

describe("formatTokenCount", () => {
  it.each([
    [1, "1"],
    [1023, "1023"],
    [1024, "1k"],
    [1536, "1.5k"],
    [8192, "8k"],
    [10_000, "9.8k"],
    [131_072, "128k"]
  ])("abbreviates %d tokens as %s", (tokens, text) => {
    expect(formatTokenCount(tokens)).toBe(text)
  })
})

/** Configuration of a model loaded with the committed default. */
const LOADED: CompleteModelLoadConfiguration = FIRST_RUN_LOAD_CONFIGURATION

/** Configuration that differs from {@link LOADED} in every setting. */
const STORED: CompleteModelLoadConfiguration = Object.freeze({
  contextLength: 16_384,
  evalBatchSize: 1024,
  flashAttention: false,
  offloadKVCacheToGpu: false,
  numExperts: 4
})

describe("formatModelLoadSetting", () => {
  it.each([
    ["contextLength", "8k", LOADED],
    ["evalBatchSize", "512", LOADED],
    ["flashAttention", "on", LOADED],
    ["flashAttention", "off", STORED],
    ["offloadKVCacheToGpu", "on", LOADED],
    ["offloadKVCacheToGpu", "off", STORED],
    ["numExperts", "auto", LOADED],
    ["numExperts", "4", STORED]
  ] as const)("shows %s as %s", (setting, text, configuration) => {
    expect(formatModelLoadSetting(setting, configuration)).toBe(text)
  })
})

describe("listModelLoadDifferences", () => {
  it("lists nothing for configurations that hold the same settings", () => {
    expect(listModelLoadDifferences(LOADED, { ...LOADED })).toEqual([])
  })

  it("describes each differing setting in the Model pane's order", () => {
    expect(listModelLoadDifferences(LOADED, STORED)).toEqual([
      {
        setting: "contextLength",
        loadedValue: "8k",
        loadedPhrase: "ctx 8k",
        storedPhrase: "ctx 16k"
      },
      {
        setting: "evalBatchSize",
        loadedValue: "512",
        loadedPhrase: "batch 512",
        storedPhrase: "batch 1024"
      },
      {
        setting: "flashAttention",
        loadedValue: "on",
        loadedPhrase: "flash attn on",
        storedPhrase: "flash attn off"
      },
      {
        setting: "offloadKVCacheToGpu",
        loadedValue: "on",
        loadedPhrase: "kv cache on gpu",
        storedPhrase: "kv cache in ram"
      },
      {
        setting: "numExperts",
        loadedValue: "auto",
        loadedPhrase: "experts auto",
        storedPhrase: "experts 4"
      }
    ])
  })

  it("lists only the settings that differ", () => {
    const stored = { ...LOADED, evalBatchSize: 256 }

    expect(
      listModelLoadDifferences(LOADED, stored).map(({ setting }) => setting)
    ).toEqual(["evalBatchSize"])
  })
})

describe("formatModelReloadNote", () => {
  it("says what the model was loaded with and what a reload would apply", () => {
    expect(
      formatModelReloadNote([
        {
          setting: "contextLength",
          loadedValue: "8k",
          loadedPhrase: "ctx 8k",
          storedPhrase: "ctx 16k"
        },
        {
          setting: "flashAttention",
          loadedValue: "on",
          loadedPhrase: "flash attn on",
          storedPhrase: "flash attn off"
        }
      ])
    ).toBe(
      "loaded with ctx 8k, flash attn on · reload to apply ctx 16k, flash attn off"
    )
  })
})

describe("findLoadConfigurationTarget", () => {
  /** Inventory in which the second model is loaded. */
  const models = [
    { modelKey: "qwen3-8b", maxContextLength: 8192, loaded: false },
    { modelKey: "gemma-3", maxContextLength: 32_768, loaded: true }
  ]

  it("finds the selected default model's own inventory entry", () => {
    expect(findLoadConfigurationTarget(models, "qwen3-8b")).toBe(models[0])
  })

  it("finds nothing without a selected default model, even while a model is loaded", () => {
    expect(findLoadConfigurationTarget(models, null)).toBeUndefined()
  })

  it("finds nothing when the inventory does not list the default model", () => {
    expect(findLoadConfigurationTarget(models, "phi-4")).toBeUndefined()
  })
})
