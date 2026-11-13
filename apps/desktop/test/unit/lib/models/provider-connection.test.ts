import { llmProviderSettingsSchema } from "@lys/share"
import { describe, expect, it } from "vitest"
import {
  calculateProviderAvailability,
  calculateProviderStatusTone,
  formatModelReferenceLabel,
  formatProviderConnectionsSummary,
  formatProviderStatusLabel,
  formatProviderStatusMeta,
  formatProviderUnreachableMessage,
  listEnabledProviders,
  listRefreshableProviders
} from "@/lib/models/provider-connection"
import {
  buildModelAvailabilitySource,
  buildProviderModelStates
} from "../../support/providerModelFixtures"
import {
  GROQ_TARGET,
  LM_STUDIO_TARGET
} from "../../support/providerTargetFixtures"

describe("calculateProviderAvailability", () => {
  it.each(["starting", "stopping", "stopped", "unresponsive"] as const)(
    "reports the backend offline while it is %s, even with a stale connected status",
    (backendStatus) => {
      const source = buildModelAvailabilitySource({
        backendStatus,
        providers: { lmStudio: { status: "connected" } }
      })

      expect(calculateProviderAvailability(source, "lmStudio")).toBe(
        "backend-offline"
      )
    }
  )

  it.each([
    ["connected", "available"],
    ["unreachable", "provider-unreachable"],
    ["connecting", "provider-connecting"],
    ["unknown", "provider-connecting"],
    ["off", "provider-off"]
  ] as const)(
    "maps a turned-on provider's %s status to %s while the backend runs",
    (status, availability) => {
      const source = buildModelAvailabilitySource({
        providers: { groq: { status } }
      })

      expect(calculateProviderAvailability(source, "groq")).toBe(availability)
    }
  )

  it("reports a provider the settings leave off as off, whatever its status", () => {
    const source = buildModelAvailabilitySource({
      enabledProviders: ["lmStudio"],
      providers: { groq: { status: "connected" } }
    })

    expect(calculateProviderAvailability(source, "groq")).toBe("provider-off")
  })

  it("answers for each provider on its own", () => {
    const source = buildModelAvailabilitySource({
      providers: {
        lmStudio: { status: "unreachable" },
        groq: { status: "connected" }
      }
    })

    expect(calculateProviderAvailability(source, "lmStudio")).toBe(
      "provider-unreachable"
    )
    expect(calculateProviderAvailability(source, "groq")).toBe("available")
  })
})

describe("formatProviderStatusLabel", () => {
  it.each([
    ["unknown", "LM Studio status unknown"],
    ["connecting", "Connecting to LM Studio"],
    ["connected", "LM Studio connected"],
    ["unreachable", "LM Studio not reachable"],
    ["off", "LM Studio is off"]
  ] as const)("labels %s as %j", (status, label) => {
    expect(formatProviderStatusLabel(status, LM_STUDIO_TARGET)).toBe(label)
  })

  it("names the provider it describes", () => {
    expect(formatProviderStatusLabel("connected", GROQ_TARGET)).toBe(
      "Groq connected"
    )
  })
})

describe("formatProviderStatusMeta", () => {
  it.each([
    [
      "unknown",
      "running",
      "127.0.0.1:1234 · status unavailable · refresh to check"
    ],
    ["unknown", "stopped", "127.0.0.1:1234 · start the backend first"],
    [
      "unknown",
      "starting",
      "127.0.0.1:1234 · waiting for the backend to start"
    ],
    ["unknown", "stopping", "127.0.0.1:1234 · the backend is stopping"],
    [
      "unknown",
      "unresponsive",
      "127.0.0.1:1234 · the backend is not responding"
    ],
    ["connecting", "running", "127.0.0.1:1234 · connecting"],
    ["connected", "running", "127.0.0.1:1234"],
    [
      "unreachable",
      "running",
      "127.0.0.1:1234 · start LM Studio, then refresh"
    ],
    ["off", "running", "127.0.0.1:1234 · turn it on in Providers"]
  ] as const)(
    "describes %s with the backend %s as %j",
    (status, backendStatus, meta) => {
      expect(
        formatProviderStatusMeta(status, backendStatus, LM_STUDIO_TARGET)
      ).toBe(meta)
    }
  )

  it("asks to check the key of a hosted provider that is not reachable", () => {
    expect(
      formatProviderStatusMeta("unreachable", "running", GROQ_TARGET)
    ).toBe("api.groq.com · check the key in Providers, then refresh")
  })
})

describe("formatProviderUnreachableMessage", () => {
  it("asks to start a provider at an address, or to check its address", () => {
    expect(formatProviderUnreachableMessage(LM_STUDIO_TARGET)).toBe(
      "LM Studio is not reachable. Start LM Studio, or check its address in Providers, then press Refresh on its status in Runtime."
    )
  })

  it("asks to check a hosted provider's key and the network", () => {
    expect(formatProviderUnreachableMessage(GROQ_TARGET)).toBe(
      "Groq is not reachable. Check its key in Providers and your network, then press Refresh on its status in Runtime."
    )
  })
})

describe("calculateProviderStatusTone", () => {
  it.each([
    ["unknown", "idle"],
    ["off", "idle"],
    ["connecting", "pending"],
    ["connected", "active"],
    ["unreachable", "danger"]
  ] as const)("shows %s in the %s tone", (status, tone) => {
    expect(calculateProviderStatusTone(status)).toBe(tone)
  })
})

describe("listEnabledProviders", () => {
  it("lists the turned-on providers in provider order, whatever the saved order", () => {
    expect(listEnabledProviders(["groq", "lmStudio", "ollamaCloud"])).toEqual([
      "lmStudio",
      "ollamaCloud",
      "groq"
    ])
    expect(listEnabledProviders([])).toEqual([])
  })
})

describe("listRefreshableProviders", () => {
  it("lists every turned-on provider that is not connecting, in provider order", () => {
    const providers = llmProviderSettingsSchema.parse({
      enabled: ["groq", "ollama", "lmStudio"],
      lmStudio: { address: null },
      ollama: { address: null }
    })
    const providerModels = buildProviderModelStates({
      lmStudio: { status: "unreachable" },
      ollama: { status: "connecting" },
      groq: { status: "off" },
      ollamaCloud: { status: "connected" }
    })

    expect(listRefreshableProviders(providers, providerModels)).toEqual([
      "lmStudio",
      "groq"
    ])
  })
})

describe("formatProviderConnectionsSummary", () => {
  it.each([
    [0, "No provider is on · turn one on in Providers"],
    [1, "1 provider on"],
    [3, "3 providers on"]
  ] as const)("summarizes %i turned-on providers as %s", (count, summary) => {
    expect(formatProviderConnectionsSummary(count)).toBe(summary)
  })
})

describe("formatModelReferenceLabel", () => {
  it("names the model with its provider, so one key on two providers reads as two models", () => {
    expect(
      formatModelReferenceLabel({ provider: "lmStudio", modelKey: "qwen3-8b" })
    ).toBe("qwen3-8b · LM Studio")
    expect(
      formatModelReferenceLabel({ provider: "ollama", modelKey: "qwen3-8b" })
    ).toBe("qwen3-8b · Ollama")
  })
})
