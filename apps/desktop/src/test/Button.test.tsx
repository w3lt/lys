import { render, screen } from "@testing-library/react"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { Button } from "@/components/ui/button"
import winglineStyles from "@/components/ui/wingline.css?inline"

let winglineStyleElement: HTMLStyleElement

beforeAll(() => {
  winglineStyleElement = document.createElement("style")
  winglineStyleElement.textContent = winglineStyles
  document.head.append(winglineStyleElement)
})

afterAll(() => {
  winglineStyleElement.remove()
})

describe("Button", () => {
  it.each([
    ["default", {}],
    ["Lys primary", { variant: "lysPrimary" as const }],
    ["small", { size: "sm" as const }],
    ["icon", { size: "icon" as const }]
  ])("uses the canonical control radius for the %s shape", (label, props) => {
    render(<Button {...props}>{label}</Button>)

    expect(screen.getByRole("button", { name: label })).toHaveClass(
      "rounded-[var(--app-radius-control)]"
    )
  })

  it.each([
    ["default", {}],
    ["Lys primary", { variant: "lysPrimary" as const }]
  ])("exposes the resting Wingline Trace for the %s action", (label, props) => {
    render(<Button {...props}>{label}</Button>)

    expect(screen.getByRole("button", { name: label })).toHaveAttribute(
      "data-lys-wingline",
      "primary"
    )
  })

  it.each([
    ["outline", { variant: "outline" as const }],
    ["Lys outline", { variant: "lysOutline" as const }]
  ])(
    "exposes an interaction-only Wingline Trace for the %s action",
    (label, props) => {
      render(<Button {...props}>{label}</Button>)

      expect(screen.getByRole("button", { name: label })).toHaveAttribute(
        "data-lys-wingline",
        "interactive"
      )
    }
  )

  it.each([
    ["secondary", "secondary" as const],
    ["ghost", "ghost" as const],
    ["destructive", "destructive" as const],
    ["link", "link" as const],
    ["Lys ghost", "lysGhost" as const],
    ["Lys danger", "lysDanger" as const],
    ["Lys metadata", "lysMeta" as const],
    ["Lys navigation", "lysNav" as const]
  ])("omits the Wingline Trace from the %s action", (label, variant) => {
    render(<Button variant={variant}>{label}</Button>)

    expect(screen.getByRole("button", { name: label })).not.toHaveAttribute(
      "data-lys-wingline"
    )
  })

  it("attaches the reusable Wingline styling hook", () => {
    render(<Button>Primary action</Button>)

    expect(screen.getByRole("button", { name: "Primary action" })).toHaveClass(
      "lys-wingline"
    )
  })

  it("keeps the selected variant authoritative over forwarded data attributes", () => {
    render(
      <Button data-lys-wingline="primary" variant="lysOutline">
        Outline action
      </Button>
    )

    expect(
      screen.getByRole("button", { name: "Outline action" })
    ).toHaveAttribute("data-lys-wingline", "interactive")
  })

  it("disables trace transitions when an interaction-only action is disabled", () => {
    render(
      <Button aria-pressed="true" disabled variant="lysOutline">
        Disabled outline
      </Button>
    )

    const style = getComputedStyle(
      screen.getByRole("button", { name: "Disabled outline" })
    )

    expect(style.getPropertyValue("--lys-wingline-transition").trim()).toBe(
      "none"
    )
  })
})
