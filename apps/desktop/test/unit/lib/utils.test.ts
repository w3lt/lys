import { describe, expect, it } from "vitest"
import { cn } from "@/lib/utils"
import indexStylesheet from "@/index.css?raw"

/**
 * Lists the type-scale steps `index.css` declares as `--text-<step>` theme
 * values, leaving out their paired line heights and the namespace reset.
 *
 * @returns The step names, in declaration order.
 */
function listDeclaredTypeSteps(): string[] {
  return [...indexStylesheet.matchAll(/^\s*--text-([a-z]+):/gm)].map(
    (declaration) => declaration[1]
  )
}

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

  it("knows every step index.css declares as a font size, not a color", () => {
    const steps = listDeclaredTypeSteps()

    expect(steps).toHaveLength(9)
    for (const step of steps) {
      expect(cn(`text-${step}`, "text-[var(--app-text)]")).toBe(
        `text-${step} text-[var(--app-text)]`
      )
    }
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
