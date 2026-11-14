import { llmProviderSettingsSchema } from "@lys/share"
import { describe, expect, it } from "vitest"
import {
  calculateProviderAvailability,
  calculateProviderConnectionState,
  calculateProviderReadiness,
  calculateProviderStatusTone,
  formatModelReferenceLabel,
  formatProviderConnectionsSummary,
  formatProviderStatusLabel,
  formatProviderStatusMeta,
  listEnabledProviders,
  listRefreshableProviders
} from "@/lib/models/provider-connection"
import type { SecretsSettings } from "@/lib/store/settings"
import {
  buildModelAvailabilitySource,
  buildProviderModelStates
} from "../../support/providerModelFixtures"
import {
  GROQ_TARGET,
  LM_STUDIO_TARGET
} from "../../support/providerTargetFixtures"
import { STORED_SETTINGS } from "../../support/settingsFixtures"

/** Saved keys without the Groq key the stored ones hold. */
const NO_GROQ_KEY: SecretsSettings = Object.freeze({
  ...STORED_SETTINGS.secrets,
  groqApiKey: null
})

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

describe("calculateProviderReadiness", () => {
  it.each(["connected", "connecting", "unreachable", "unknown"] as const)(
    "says a turned-on Groq without a key needs one while its status is %s",
    (status) => {
      const source = buildModelAvailabilitySource({
        providers: { groq: { status } }
      })

      expect(calculateProviderReadiness(source, NO_GROQ_KEY, "groq")).toBe(
        "provider-needs-key"
      )
    }
  )

  it("keeps a Groq the settings leave off as off, though it has no key", () => {
    const source = buildModelAvailabilitySource({
      enabledProviders: ["lmStudio"],
      providers: { groq: { status: "unreachable" } }
    })

    expect(calculateProviderReadiness(source, NO_GROQ_KEY, "groq")).toBe(
      "provider-off"
    )
  })

  it("keeps the backend offline first, though Groq has no key", () => {
    const source = buildModelAvailabilitySource({
      backendStatus: "stopped",
      providers: { groq: { status: "unknown" } }
    })

    expect(calculateProviderReadiness(source, NO_GROQ_KEY, "groq")).toBe(
      "backend-offline"
    )
  })

  it.each([
    ["groq", "connected", "available"],
    ["groq", "unreachable", "provider-unreachable"],
    ["lmStudio", "connecting", "provider-connecting"],
    ["lmStudio", "connected", "available"]
  ] as const)(
    "follows the availability of %s, whose key is saved or not needed, while it is %s",
    (provider, status, readiness) => {
      const source = buildModelAvailabilitySource({
        providers: { [provider]: { status } }
      })

      expect(
        calculateProviderReadiness(source, STORED_SETTINGS.secrets, provider)
      ).toBe(readiness)
    }
  )

  it("asks no key of a provider reached at an address", () => {
    const source = buildModelAvailabilitySource({
      providers: { lmStudio: { status: "connected" } }
    })
    const noKey: SecretsSettings = { ...NO_GROQ_KEY, ollamaApiKey: null }

    expect(calculateProviderReadiness(source, noKey, "lmStudio")).toBe(
      "available"
    )
  })
})

describe("calculateProviderConnectionState", () => {
  it.each([
    "unknown",
    "connecting",
    "connected",
    "unreachable",
    "off"
  ] as const)(
    "says a provider without the key it needs needs one, whatever its %s status",
    (status) => {
      expect(
        calculateProviderConnectionState("groq", status, NO_GROQ_KEY)
      ).toBe("needs-key")
    }
  )

  it("keeps the status of a provider whose key is saved, or that needs none", () => {
    expect(
      calculateProviderConnectionState(
        "groq",
        "unreachable",
        STORED_SETTINGS.secrets
      )
    ).toBe("unreachable")
    expect(
      calculateProviderConnectionState("lmStudio", "connected", NO_GROQ_KEY)
    ).toBe("connected")
  })
})

describe("formatProviderStatusLabel", () => {
  it.each([
    ["unknown", "LM Studio status unknown"],
    ["connecting", "Connecting to LM Studio"],
    ["connected", "LM Studio connected"],
    ["unreachable", "LM Studio not reachable"],
    ["off", "LM Studio is off"],
    ["needs-key", "LM Studio needs a key"]
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
    [
      "off",
      "running",
      "127.0.0.1:1234 · the backend has LM Studio off · refresh to check again"
    ]
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

  it("asks to add the key of a provider that needs one", () => {
    expect(formatProviderStatusMeta("needs-key", "running", GROQ_TARGET)).toBe(
      "api.groq.com · add its key in Providers"
    )
  })
})

describe("calculateProviderStatusTone", () => {
  it.each([
    ["unknown", "idle"],
    ["off", "idle"],
    ["connecting", "pending"],
    ["connected", "active"],
    ["unreachable", "danger"],
    ["needs-key", "warning"]
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
