import type { LlmTestModelApiResponse } from "@lys/protocol"
import { describe, expect, it } from "vitest"
import {
  buildModelProviderSummary,
  describeCloudModelStatus,
  formatModelFilterResult,
  formatModelRefreshNote,
  isModelDefaultActionDisabled,
  type ModelCheckObservation
} from "@/components/SettingsViewComponents/model-pane-presentation"
import type { LlmProviderTarget } from "@/lib/models/llm-provider-target"
import type { ModelInventoryState } from "@/lib/store/model-runtime"
import { buildLlmInfo } from "../../support/modelFixtures"

/** LM Studio, reached at its default address. */
const LM_STUDIO: LlmProviderTarget = Object.freeze({
  provider: "lmStudio",
  name: "LM Studio",
  access: "address",
  location: "127.0.0.1:1234"
})

/** Groq, reached with a key. */
const GROQ: LlmProviderTarget = Object.freeze({
  provider: "groq",
  name: "Groq",
  access: "key",
  location: "api.groq.com"
})

/** An inventory with one loaded model and one on disk. */
const TWO_MODELS: ModelInventoryState = Object.freeze({
  status: "ready",
  modelLoading: "lys",
  models: [buildLlmInfo("qwen3-8b", { loaded: true }), buildLlmInfo("gemma")]
})

/** A time whose hour and minute need a leading zero. */
const NINE_OH_FIVE = new Date(2026, 10, 13, 9, 5)

/** A Groq model the cloud status cases describe. */
const MODEL_KEY = "llama-3.3-70b"

/**
 * Builds the observation of a cloud model nobody checked.
 *
 * @param change - Parts the case sets.
 * @returns The observation.
 */
function buildObservation(
  change: Partial<ModelCheckObservation> = {}
): ModelCheckObservation {
  return {
    request: { status: "idle" },
    health: null,
    error: null,
    settledAt: null,
    isCheckRequested: false,
    ...change
  }
}

/**
 * Builds a health observation of one model that the provider answered.
 *
 * @param modelId - Key of the observed model.
 * @param isReady - Whether the provider offers the model.
 * @returns The observation.
 */
function buildHealth(
  modelId: string,
  isReady: boolean
): LlmTestModelApiResponse {
  return isReady
    ? { modelId, status: "ready", latencyMs: 40 }
    : {
        modelId,
        status: "not-ready",
        reason: "model-not-loaded",
        latencyMs: 40
      }
}

describe("buildModelProviderSummary", () => {
  it.each([
    ["available", "active", "Running"],
    ["provider-connecting", "pending", "Connecting…"],
    ["provider-unreachable", "danger", "Not running"],
    ["provider-off", "idle", "Off"],
    ["backend-offline", "idle", "Backend not running"]
  ] as const)(
    "gives a provider on this machine that is %s the %s tone and says %s",
    (availability, tone, status) => {
      expect(
        buildModelProviderSummary(LM_STUDIO, availability, TWO_MODELS, null)
      ).toMatchObject({ tone, status })
    }
  )

  it("says a cloud provider is connected, or can't be reached", () => {
    expect(
      [
        buildModelProviderSummary(GROQ, "available", TWO_MODELS, null),
        buildModelProviderSummary(
          GROQ,
          "provider-unreachable",
          TWO_MODELS,
          null
        )
      ].map((summary) => summary.status)
    ).toEqual(["Connected", "Can’t be reached"])
  })

  it("counts the loaded models on this machine, and every cloud model", () => {
    expect(
      [LM_STUDIO, GROQ].map(
        (target) =>
          buildModelProviderSummary(target, "available", TWO_MODELS, null).count
      )
    ).toEqual(["1 of 2 loaded", "2 models"])
  })

  it("counts a single cloud model in the singular", () => {
    const inventory: ModelInventoryState = {
      status: "ready",
      modelLoading: "provider",
      models: [buildLlmInfo(MODEL_KEY)]
    }

    expect(
      buildModelProviderSummary(GROQ, "available", inventory, null).count
    ).toBe("1 model")
  })

  it("counts nothing until an inventory is read", () => {
    expect(
      buildModelProviderSummary(
        LM_STUDIO,
        "available",
        { status: "failed" },
        null
      ).count
    ).toBeNull()
  })

  it("names the default model only when it is the provider's", () => {
    expect(
      [
        { provider: "lmStudio", modelKey: "qwen3-8b" } as const,
        { provider: "groq", modelKey: MODEL_KEY } as const
      ].map(
        (defaultModel) =>
          buildModelProviderSummary(
            LM_STUDIO,
            "available",
            TWO_MODELS,
            defaultModel
          ).defaultModelKey
      )
    ).toEqual(["qwen3-8b", null])
  })
})

describe("formatModelRefreshNote", () => {
  it("says the provider is being asked while it lists its models", () => {
    expect(
      formatModelRefreshNote({ status: "listing" }, NINE_OH_FIVE, "LM Studio")
    ).toBe("Asking LM Studio…")
  })

  it("gives the time the latest operation settled on a 24-hour clock", () => {
    expect(
      formatModelRefreshNote({ status: "idle" }, NINE_OH_FIVE, "LM Studio")
    ).toBe("Refreshed at 09:05")
  })

  it("says nothing before an operation settled", () => {
    expect(formatModelRefreshNote({ status: "idle" }, null, "LM Studio")).toBe(
      ""
    )
  })
})

describe("formatModelFilterResult", () => {
  it("counts the models the filter shows", () => {
    expect([
      formatModelFilterResult(2, 2, ""),
      formatModelFilterResult(1, 2, "gemma")
    ]).toEqual(["All models · 2", "Showing 1 of 2"])
  })

  it("quotes the typed text when no model matches it", () => {
    expect(formatModelFilterResult(0, 2, " zzz")).toBe(
      "No model matches “ zzz”."
    )
  })
})

describe("describeCloudModelStatus", () => {
  it("says a listed Groq model is available and what Check status asks", () => {
    expect(
      describeCloudModelStatus("groq", MODEL_KEY, buildObservation())
    ).toEqual({
      tone: "active",
      word: "Available",
      place: "Hosted by Groq",
      note: "Check status asks Groq whether it still offers this model to your key. It does not generate a reply."
    })
  })

  it("says Ollama Cloud runs a listed model when a message names it", () => {
    expect(
      describeCloudModelStatus(
        "ollamaCloud",
        "gpt-oss:120b",
        buildObservation()
      )
    ).toMatchObject({
      tone: "active",
      word: "Available",
      place: "Ollama Cloud runs it when a message names it"
    })
  })

  it("says the model is being checked while its check runs", () => {
    expect(
      describeCloudModelStatus(
        "groq",
        MODEL_KEY,
        buildObservation({
          request: { status: "testing", modelKey: MODEL_KEY }
        })
      )
    ).toMatchObject({
      tone: "pending",
      word: "Checking…",
      place: "Asking Groq…"
    })
  })

  it("keeps the model available while another model's check runs", () => {
    expect(
      describeCloudModelStatus(
        "groq",
        MODEL_KEY,
        buildObservation({ request: { status: "testing", modelKey: "other" } })
      ).word
    ).toBe("Available")
  })

  it("says when the provider still offered the model at its check", () => {
    expect(
      describeCloudModelStatus(
        "groq",
        MODEL_KEY,
        buildObservation({
          health: buildHealth(MODEL_KEY, true),
          settledAt: NINE_OH_FIVE,
          isCheckRequested: true
        })
      )
    ).toEqual({
      tone: "active",
      word: "Available",
      place: "Hosted by Groq",
      note: "Checked at 09:05. Groq still offers it to your key."
    })
  })

  it("says the model is not available when the check found it not offered", () => {
    expect(
      describeCloudModelStatus(
        "ollamaCloud",
        "gpt-oss:120b",
        buildObservation({
          health: buildHealth("gpt-oss:120b", false),
          settledAt: NINE_OH_FIVE,
          isCheckRequested: true
        })
      )
    ).toEqual({
      tone: "idle",
      word: "Not available",
      place: "Not offered to your key on Ollama Cloud",
      note: "Checked at 09:05. Ollama Cloud doesn’t offer it to your key now."
    })
  })

  it("ignores another model's check", () => {
    expect(
      describeCloudModelStatus(
        "groq",
        MODEL_KEY,
        buildObservation({
          health: buildHealth("other", false),
          settledAt: NINE_OH_FIVE,
          isCheckRequested: true
        })
      ).word
    ).toBe("Available")
  })

  it.each([
    ["the request failed", { error: "Groq didn’t answer." }],
    [
      "the runtime was unavailable",
      {
        health: {
          modelId: MODEL_KEY,
          status: "not-ready",
          reason: "runtime-unavailable",
          latencyMs: 40
        }
      }
    ]
  ] as const)(
    "says an asked-for check failed when %s, with the last known state",
    (_situation, change) => {
      expect(
        describeCloudModelStatus(
          "groq",
          MODEL_KEY,
          buildObservation({
            ...change,
            settledAt: NINE_OH_FIVE,
            isCheckRequested: true
          })
        )
      ).toEqual({
        tone: "danger",
        word: "Couldn’t check",
        place: "",
        note: "Groq didn’t answer. The last known state was available."
      })
    }
  )

  it("reports no failure of a check that was not asked for", () => {
    expect(
      describeCloudModelStatus(
        "groq",
        MODEL_KEY,
        buildObservation({ error: "Groq didn’t answer." })
      ).word
    ).toBe("Available")
  })
})

describe("isModelDefaultActionDisabled", () => {
  it.each([
    ["set", { status: "idle" }, false],
    ["set", { status: "loading", modelKey: "other" }, false],
    ["set", { status: "unloading", modelKey: "other" }, false],
    ["set", { status: "unloading", modelKey: "qwen3-8b" }, true],
    ["load-and-set", { status: "idle" }, false],
    ["load-and-set", { status: "listing" }, true],
    ["load-and-set", { status: "loading", modelKey: "other" }, true],
    ["loading", { status: "loading", modelKey: "qwen3-8b" }, true],
    ["current", { status: "idle" }, false]
  ] as const)(
    "disables %s while the provider's request is %o: %s",
    (choice, request, isDisabled) => {
      expect(isModelDefaultActionDisabled(choice, request, "qwen3-8b")).toBe(
        isDisabled
      )
    }
  )
})
