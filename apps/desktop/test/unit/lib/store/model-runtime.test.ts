import { describe, expect, it } from "vitest"
import {
  addSentModelConfiguration,
  buildLoadedModelConfigurations,
  buildModelRuntime,
  isModelTransitionInFlight,
  removeLoadedModelConfiguration,
  type LoadedModelConfiguration,
  type LoadedModelConfigurations,
  type ModelInventoryState,
  type ModelRuntimeState
} from "@/lib/store/model-runtime"
import type { LoadConfigurationSettings } from "@/lib/store/settings"
import { buildLlmInfo } from "../../support/modelFixtures"
import { FIRST_RUN_LOAD_CONFIGURATION } from "../../support/settingsFixtures"

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

  it("reports residency as unavailable, not as empty, while the inventory cannot be read", () => {
    expect(
      buildModelRuntime({ status: "unavailable" }, { status: "idle" }, null)
    ).toEqual({ status: "unavailable" })
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
    [{ status: "unknown" }, false],
    [{ status: "unavailable" }, false]
  ])("answers %o with %s", (modelRuntime, isInFlight) => {
    expect(isModelTransitionInFlight(modelRuntime)).toBe(isInFlight)
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
