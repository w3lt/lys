import { describe, expect, it } from "vitest"
import {
  calculateLmStudioStatusTone,
  calculateModelRuntimeAvailability,
  formatLmStudioStatusLabel,
  formatLmStudioStatusMeta
} from "@/lib/models/lm-studio-connection"

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
    expect(formatLmStudioStatusLabel(lmStudioStatus)).toBe(label)
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
    ["unknown", "starting", "127.0.0.1:1234 · start the backend first"],
    ["connecting", "running", "127.0.0.1:1234 · connecting"],
    ["connected", "running", "127.0.0.1:1234"],
    ["unreachable", "running", "127.0.0.1:1234 · start LM Studio, then refresh"]
  ] as const)(
    "describes %s with the backend %s as %j",
    (lmStudioStatus, backendStatus, meta) => {
      expect(formatLmStudioStatusMeta(lmStudioStatus, backendStatus)).toBe(meta)
    }
  )
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
