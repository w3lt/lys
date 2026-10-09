import { describe, expect, it } from "vitest"
import {
  calculateBackendStatusTone,
  formatBackendStatusLabel,
  formatUptime
} from "@/lib/hooks/backendRuntime"

describe("formatBackendStatusLabel", () => {
  it.each([
    ["running", "Backend running"],
    ["starting", "Backend starting"],
    ["stopping", "Backend stopping"],
    ["stopped", "Backend stopped"],
    ["unresponsive", "Backend not responding"]
  ] as const)("labels %s as %j", (status, label) => {
    expect(formatBackendStatusLabel(status)).toBe(label)
  })
})

describe("calculateBackendStatusTone", () => {
  it.each([
    ["running", "active"],
    ["starting", "pending"],
    ["stopping", "pending"],
    ["stopped", "idle"],
    ["unresponsive", "danger"]
  ] as const)("shows %s in the %s tone", (status, tone) => {
    expect(calculateBackendStatusTone(status)).toBe(tone)
  })
})

describe("formatUptime", () => {
  it.each([
    [0, "0s"],
    [999, "0s"],
    [59_999, "59s"],
    [60_000, "1m 0s"],
    [61_500, "1m 1s"],
    [3_600_000, "60m 0s"],
    [-5_000, "0s"]
  ])("formats %d ms as %j", (elapsedMs, label) => {
    expect(formatUptime(elapsedMs)).toBe(label)
  })
})
