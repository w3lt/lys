import { describe, expect, it } from "vitest"
import {
  calculateLmStudioStatusTone,
  calculateModelRuntimeAvailability,
  formatLmStudioStatusLabel,
  formatLmStudioStatusMeta,
  formatProviderUnreachableMessage
} from "@/lib/models/lm-studio-connection"
import {
  GROQ_TARGET,
  LM_STUDIO_TARGET
} from "../../support/providerTargetFixtures"

describe("calculateModelRuntimeAvailability", () => {
  it.each(["starting", "stopping", "stopped", "unresponsive"] as const)(
    "reports the backend offline while it is %s, even with a stale connected status",
    (backendStatus) => {
      expect(
        calculateModelRuntimeAvailability(backendStatus, "connected")
      ).toBe("backend-offline")
    }
  )

  it.each([
    ["connected", "available"],
    ["unreachable", "lm-studio-unreachable"],
    ["connecting", "lm-studio-connecting"],
    ["unknown", "lm-studio-connecting"]
  ] as const)(
    "maps LM Studio %s to %s while the backend runs",
    (lmStudioStatus, availability) => {
      expect(calculateModelRuntimeAvailability("running", lmStudioStatus)).toBe(
        availability
      )
    }
  )
})

describe("formatLmStudioStatusLabel", () => {
  it.each([
    ["unknown", "LM Studio status unknown"],
    ["connecting", "Connecting to LM Studio"],
    ["connected", "LM Studio connected"],
    ["unreachable", "LM Studio not reachable"]
  ] as const)("labels %s as %j", (lmStudioStatus, label) => {
    expect(formatLmStudioStatusLabel(lmStudioStatus, LM_STUDIO_TARGET)).toBe(
      label
    )
  })

  it("names the active provider", () => {
    expect(formatLmStudioStatusLabel("connected", GROQ_TARGET)).toBe(
      "Groq connected"
    )
  })
})

describe("formatLmStudioStatusMeta", () => {
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
    ["unreachable", "running", "127.0.0.1:1234 · start LM Studio, then refresh"]
  ] as const)(
    "describes %s with the backend %s as %j",
    (lmStudioStatus, backendStatus, meta) => {
      expect(
        formatLmStudioStatusMeta(
          lmStudioStatus,
          backendStatus,
          LM_STUDIO_TARGET
        )
      ).toBe(meta)
    }
  )

  it("asks to check the key of a hosted provider that is not reachable", () => {
    expect(
      formatLmStudioStatusMeta("unreachable", "running", GROQ_TARGET)
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

describe("calculateLmStudioStatusTone", () => {
  it.each([
    ["unknown", "idle"],
    ["connecting", "pending"],
    ["connected", "active"],
    ["unreachable", "danger"]
  ] as const)("shows %s in the %s tone", (lmStudioStatus, tone) => {
    expect(calculateLmStudioStatusTone(lmStudioStatus)).toBe(tone)
  })
})
