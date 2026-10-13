import { describe, expect, it } from "vitest"
import { cn } from "@/lib/utils"

describe("cn", () => {
  it("lets a later conflicting Tailwind utility override an earlier one", () => {
    expect(cn("px-2 text-sm", "px-4")).toBe("text-sm px-4")
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
