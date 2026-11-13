import { LLM_PROVIDERS } from "@lys/share"
import { describe, expect, it } from "vitest"
import {
  addSentModelConfiguration,
  buildLoadedModelConfigurations,
  INITIAL_PROVIDER_MODEL_STATES,
  RELEASED_PROVIDER_MODELS,
  removeLoadedModelConfiguration,
  updateProviderModelState,
  type LoadedModelConfiguration,
  type LoadedModelConfigurations,
  type ModelInventoryState
} from "@/lib/store/model-runtime"
import type { LoadConfigurationSettings } from "@/lib/store/settings"
import { buildLlmInfo } from "../../support/modelFixtures"
import { FIRST_RUN_LOAD_CONFIGURATION } from "../../support/settingsFixtures"

/** Inventory listing two resident models and one on disk, in that order. */
const TWO_RESIDENT: ModelInventoryState = {
  status: "ready",
  modelLoading: "lys",
  models: [
    buildLlmInfo("first", { loaded: true }),
    buildLlmInfo("on-disk"),
    buildLlmInfo("second", { loaded: true })
  ]
}

describe("INITIAL_PROVIDER_MODEL_STATES", () => {
  it("knows nothing of any provider before the backend reports", () => {
    for (const provider of LLM_PROVIDERS) {
      expect(INITIAL_PROVIDER_MODEL_STATES[provider]).toEqual({
        status: "unknown",
        ...RELEASED_PROVIDER_MODELS
      })
    }
  })
})

describe("updateProviderModelState", () => {
  it("replaces the given fields of one provider and leaves the others", () => {
    const states = updateProviderModelState(
      INITIAL_PROVIDER_MODEL_STATES,
      "groq",
      { status: "connected", inventory: TWO_RESIDENT }
    )

    expect(states.groq).toEqual({
      ...INITIAL_PROVIDER_MODEL_STATES.groq,
      status: "connected",
      inventory: TWO_RESIDENT
    })
    expect(states.lmStudio).toBe(INITIAL_PROVIDER_MODEL_STATES.lmStudio)
    expect(states.ollama).toBe(INITIAL_PROVIDER_MODEL_STATES.ollama)
    expect(states.ollamaCloud).toBe(INITIAL_PROVIDER_MODEL_STATES.ollamaCloud)
    expect(INITIAL_PROVIDER_MODEL_STATES.groq.status).toBe("unknown")
    expect(Object.isFrozen(states)).toBe(true)
    expect(Object.isFrozen(states.groq)).toBe(true)
  })
})

/** Record of a model Lys loaded in this session with a 4,096-token context. */
const SENT_RECORD: LoadedModelConfiguration = Object.freeze({
  origin: "sent",
  configuration: { ...FIRST_RUN_LOAD_CONFIGURATION, contextLength: 4096 }
})

/** Record of a model found already loaded, assumed to run the default. */
const ASSUMED_RECORD: LoadedModelConfiguration = Object.freeze({
  origin: "assumed",
  configuration: FIRST_RUN_LOAD_CONFIGURATION
})

/** Load settings of a first-run settings file: none stored. */
const NO_STORED_LOAD_SETTINGS: LoadConfigurationSettings = Object.freeze({
  default: Object.freeze({}),
  models: new Map()
})

describe("addSentModelConfiguration", () => {
  it("records the configuration a load was sent with, in place of what was assumed", () => {
    const known: LoadedModelConfigurations = new Map([
      ["first", ASSUMED_RECORD],
      ["second", ASSUMED_RECORD]
    ])

    const records = addSentModelConfiguration(
      known,
      "first",
      SENT_RECORD.configuration
    )

    expect(Object.fromEntries(records)).toEqual({
      first: SENT_RECORD,
      second: ASSUMED_RECORD
    })
    expect(known.get("first")).toBe(ASSUMED_RECORD)
  })
})

describe("removeLoadedModelConfiguration", () => {
  it("forgets one model's configuration and leaves the given records unchanged", () => {
    const known: LoadedModelConfigurations = new Map([
      ["first", SENT_RECORD],
      ["second", ASSUMED_RECORD]
    ])

    const records = removeLoadedModelConfiguration(known, "first")

    expect(Object.fromEntries(records)).toEqual({ second: ASSUMED_RECORD })
    expect(known.size).toBe(2)
  })
})

describe("buildLoadedModelConfigurations", () => {
  it("holds a record for exactly the loaded models: a known one is kept, a newly seen one is assumed", () => {
    const known: LoadedModelConfigurations = new Map([
      ["first", SENT_RECORD],
      ["on-disk", SENT_RECORD]
    ])

    const records = buildLoadedModelConfigurations(
      known,
      TWO_RESIDENT,
      NO_STORED_LOAD_SETTINGS
    )

    expect(Object.fromEntries(records)).toEqual({
      first: SENT_RECORD,
      second: ASSUMED_RECORD
    })
    expect(known.has("on-disk")).toBe(true)
  })

  it("assumes a newly seen model runs with what is stored for it now, within its own maximum", () => {
    const inventory: ModelInventoryState = {
      status: "ready",
      modelLoading: "lys",
      models: [buildLlmInfo("small", { loaded: true, maxContextLength: 4096 })]
    }
    const settings: LoadConfigurationSettings = {
      default: { evalBatchSize: 256 },
      models: new Map([["small", { flashAttention: false }]])
    }

    const records = buildLoadedModelConfigurations(
      new Map(),
      inventory,
      settings
    )

    expect(records.get("small")).toEqual({
      origin: "assumed",
      configuration: {
        contextLength: 4096,
        evalBatchSize: 256,
        flashAttention: false,
        offloadKVCacheToGpu: true
      }
    })
  })

  it.each<ModelInventoryState>([
    { status: "failed" },
    { status: "unavailable" }
  ])(
    "keeps the earlier records as they are when the inventory is $status",
    (inventory) => {
      const known: LoadedModelConfigurations = new Map([["first", SENT_RECORD]])

      expect(
        buildLoadedModelConfigurations(
          known,
          inventory,
          NO_STORED_LOAD_SETTINGS
        )
      ).toBe(known)
    }
  )
})
