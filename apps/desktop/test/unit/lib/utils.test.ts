import { describe, expect, it } from "vitest"
import { cn } from "@/lib/utils"

describe("cn", () => {
  it("lets a later conflicting Tailwind utility override an earlier one", () => {
    expect(cn("px-2 text-meta", "px-4")).toBe("text-meta px-4")
  })

  it("lets a later type-scale step or inherited size replace an earlier step", () => {
    expect(cn("text-control", "text-meta")).toBe("text-meta")
    expect(cn("text-control", "text-[length:inherit]")).toBe(
      "text-[length:inherit]"
    )
  })

  it("keeps a type-scale step when a later class sets the text color", () => {
    expect(cn("text-control", "text-[var(--app-text-link)]")).toBe(
      "text-control text-[var(--app-text-link)]"
    )
  })

  it("keeps only the active conditional class values", () => {
    expect(cn("base", false, null, undefined, { on: true, off: false })).toBe(
      "base on"
    )
  })

  it("returns an empty string when no class value is active", () => {
    expect(cn(false, { hidden: false })).toBe("")
  })
})
