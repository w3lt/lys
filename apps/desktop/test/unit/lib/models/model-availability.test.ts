import type { LlmModelReference } from "@lys/share"
import { describe, expect, it } from "vitest"
import {
  calculateModelAvailability,
  findFirstLoadedModel,
  findLoadedModelInfo,
  findNewConversationModel
} from "@/lib/models/model-availability"
import type { ModelInventoryState } from "@/lib/store/model-runtime"
import { buildLlmInfo } from "../../support/modelFixtures"
import { buildModelAvailabilitySource } from "../../support/providerModelFixtures"

/** `qwen3-8b`, listed by LM Studio. */
const QWEN: LlmModelReference = { provider: "lmStudio", modelKey: "qwen3-8b" }

/** `llama-3.3-70b`, listed by Groq. */
const LLAMA: LlmModelReference = { provider: "groq", modelKey: "llama-3.3-70b" }

/** Inventory entry of {@link QWEN} while it is loaded. */
const LOADED_QWEN = buildLlmInfo("qwen3-8b", { loaded: true })

/** Inventory entry of {@link QWEN} while it is on disk only. */
const ON_DISK_QWEN = buildLlmInfo("qwen3-8b")

/** Inventory entry of {@link LLAMA}, which a hosted provider keeps loaded. */
const LOADED_LLAMA = buildLlmInfo("llama-3.3-70b", { loaded: true })

/**
 * Builds a read inventory.
 *
 * @param models - Models it lists, in order.
 * @param modelLoading - Who loads them; Lys by default.
 * @returns The inventory.
 */
function buildInventory(
  models: ReturnType<typeof buildLlmInfo>[],
  modelLoading: "lys" | "provider" = "lys"
): ModelInventoryState {
  return { status: "ready", modelLoading, models }
}

describe("calculateModelAvailability", () => {
  it("reports a loaded model with its inventory entry", () => {
    const source = buildModelAvailabilitySource({
      providers: {
        lmStudio: {
          status: "connected",
          inventory: buildInventory([LOADED_QWEN])
        }
      }
    })

    expect(calculateModelAvailability(source, QWEN)).toEqual({
      status: "loaded",
      model: LOADED_QWEN
    })
  })

  it.each(["stopped", "starting", "stopping", "unresponsive"] as const)(
    "reports the backend not running while it is %s",
    (backendStatus) => {
      const source = buildModelAvailabilitySource({
        backendStatus,
        providers: {
          lmStudio: {
            status: "connected",
            inventory: buildInventory([LOADED_QWEN])
          }
        }
      })

      expect(calculateModelAvailability(source, QWEN)).toEqual({
        status: "backend-not-running"
      })
    }
  )

  it("reports the provider off when the settings leave it off, even with its model loaded", () => {
    const source = buildModelAvailabilitySource({
      enabledProviders: ["groq"],
      providers: {
        lmStudio: {
          status: "connected",
          inventory: buildInventory([LOADED_QWEN])
        }
      }
    })

    expect(calculateModelAvailability(source, QWEN)).toEqual({
      status: "provider-off"
    })
  })

  it.each([
    ["off", "provider-off"],
    ["unknown", "provider-connecting"],
    ["connecting", "provider-connecting"],
    ["unreachable", "provider-unreachable"]
  ] as const)(
    "reports a turned-on provider whose status is %s as %s",
    (status, availability) => {
      const source = buildModelAvailabilitySource({
        providers: { lmStudio: { status } }
      })

      expect(calculateModelAvailability(source, QWEN)).toEqual({
        status: availability
      })
    }
  )

  it.each(["loading", "unloading"] as const)(
    "reports the model %s while that request runs for it",
    (requestStatus) => {
      const source = buildModelAvailabilitySource({
        providers: {
          lmStudio: {
            status: "connected",
            inventory: buildInventory([ON_DISK_QWEN]),
            request: { status: requestStatus, modelKey: "qwen3-8b" }
          }
        }
      })

      expect(calculateModelAvailability(source, QWEN)).toEqual({
        status: requestStatus
      })
    }
  )

  it("does not report a load of another model as this model's", () => {
    const source = buildModelAvailabilitySource({
      providers: {
        lmStudio: {
          status: "connected",
          inventory: buildInventory([LOADED_QWEN, buildLlmInfo("gemma-3")]),
          request: { status: "loading", modelKey: "gemma-3" }
        }
      }
    })

    expect(calculateModelAvailability(source, QWEN).status).toBe("loaded")
  })

  it.each([
    ["unavailable", "inventory-unread"],
    ["failed", "inventory-failed"]
  ] as const)(
    "reports an inventory that is %s as %s",
    (inventoryStatus, availability) => {
      const source = buildModelAvailabilitySource({
        providers: {
          lmStudio: {
            status: "connected",
            inventory: { status: inventoryStatus }
          }
        }
      })

      expect(calculateModelAvailability(source, QWEN)).toEqual({
        status: availability
      })
    }
  )

  it("reports a model its provider does not list", () => {
    const source = buildModelAvailabilitySource({
      providers: {
        lmStudio: {
          status: "connected",
          inventory: buildInventory([buildLlmInfo("gemma-3", { loaded: true })])
        }
      }
    })

    expect(calculateModelAvailability(source, QWEN)).toEqual({
      status: "not-listed"
    })
  })

  it.each(["lys", "provider"] as const)(
    "reports a listed model that is not loaded, and that %s loads it",
    (modelLoading) => {
      const source = buildModelAvailabilitySource({
        providers: {
          lmStudio: {
            status: "connected",
            inventory: buildInventory([ON_DISK_QWEN], modelLoading)
          }
        }
      })

      expect(calculateModelAvailability(source, QWEN)).toEqual({
        status: "not-loaded",
        modelLoading,
        model: ON_DISK_QWEN
      })
    }
  )

  it("treats the same key on another provider as another model", () => {
    const source = buildModelAvailabilitySource({
      providers: {
        lmStudio: {
          status: "connected",
          inventory: buildInventory([LOADED_QWEN])
        },
        ollama: { status: "connected", inventory: buildInventory([]) }
      }
    })

    expect(
      calculateModelAvailability(source, {
        provider: "ollama",
        modelKey: "qwen3-8b"
      })
    ).toEqual({ status: "not-listed" })
  })

  it("answers for a model whatever another provider's state", () => {
    const source = buildModelAvailabilitySource({
      providers: {
        lmStudio: { status: "unreachable" },
        groq: {
          status: "connected",
          inventory: buildInventory([LOADED_LLAMA], "provider")
        }
      }
    })

    expect(calculateModelAvailability(source, LLAMA).status).toBe("loaded")
    expect(calculateModelAvailability(source, QWEN).status).toBe(
      "provider-unreachable"
    )
  })
})

describe("findLoadedModelInfo", () => {
  it("returns the entry of a loaded model", () => {
    expect(findLoadedModelInfo({ status: "loaded", model: LOADED_QWEN })).toBe(
      LOADED_QWEN
    )
  })

  it.each([
    { status: "not-loaded", modelLoading: "lys", model: ON_DISK_QWEN },
    { status: "loading" },
    { status: "provider-off" },
    null
  ] as const)("returns nothing for %o", (availability) => {
    expect(findLoadedModelInfo(availability)).toBeUndefined()
  })
})

describe("findFirstLoadedModel", () => {
  it("finds the first loaded model in provider order, then inventory order", () => {
    const source = buildModelAvailabilitySource({
      providers: {
        groq: {
          status: "connected",
          inventory: buildInventory([LOADED_LLAMA], "provider")
        },
        lmStudio: {
          status: "connected",
          inventory: buildInventory([
            buildLlmInfo("gemma-3"),
            LOADED_QWEN,
            buildLlmInfo("phi-4", { loaded: true })
          ])
        }
      }
    })

    expect(findFirstLoadedModel(source)).toEqual(QWEN)
  })

  it("skips a provider that is off or cannot answer", () => {
    const source = buildModelAvailabilitySource({
      enabledProviders: ["ollama", "groq"],
      providers: {
        lmStudio: {
          status: "connected",
          inventory: buildInventory([LOADED_QWEN])
        },
        ollama: {
          status: "connected",
          inventory: buildInventory([
            buildLlmInfo("mistral", { loaded: true })
          ]),
          request: { status: "unloading", modelKey: "mistral" }
        },
        groq: {
          status: "connected",
          inventory: buildInventory([LOADED_LLAMA], "provider")
        }
      }
    })

    expect(findFirstLoadedModel(source)).toEqual(LLAMA)
  })

  it("finds none while no model can answer", () => {
    const source = buildModelAvailabilitySource({
      providers: {
        lmStudio: {
          status: "connected",
          inventory: buildInventory([ON_DISK_QWEN])
        }
      }
    })

    expect(findFirstLoadedModel(source)).toBeNull()
  })
})

describe("findNewConversationModel", () => {
  /** A source in which only Groq's model can answer. */
  const SOURCE = buildModelAvailabilitySource({
    providers: {
      lmStudio: { status: "unreachable" },
      groq: {
        status: "connected",
        inventory: buildInventory([LOADED_LLAMA], "provider")
      }
    }
  })

  it("uses the default model, even while it cannot answer", () => {
    expect(findNewConversationModel(SOURCE, QWEN)).toBe(QWEN)
  })

  it("uses the first model that can answer without a default", () => {
    expect(findNewConversationModel(SOURCE, null)).toEqual(LLAMA)
  })

  it("uses no model without a default or a model that can answer", () => {
    expect(
      findNewConversationModel(buildModelAvailabilitySource(), null)
    ).toBeNull()
  })
})
