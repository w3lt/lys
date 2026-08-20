import { describe, expect, it } from "vitest"
import StatusBadge from "./StatusBadge.astro"
import { renderComponent } from "@/test/render"
import {
  DOCUMENT_STATUS_PRESENTATION,
  type DocumentStatus
} from "@/lib/handbook/status"

const everyStatus = Object.keys(
  DOCUMENT_STATUS_PRESENTATION
) as readonly DocumentStatus[]

describe("StatusBadge", () => {
  it.each(everyStatus)(
    "reads as %s in text, so colour is never the only cue",
    async (status) => {
      const document = await renderComponent(StatusBadge, { status })

      expect(document.body.textContent).toContain(
        DOCUMENT_STATUS_PRESENTATION[status].label
      )
    }
  )

  it.each(everyStatus)(
    "hides the %s glyph from assistive technology",
    async (status) => {
      const document = await renderComponent(StatusBadge, { status })
      const glyph = document.querySelector('[aria-hidden="true"]')

      expect(glyph?.textContent).toBe(DOCUMENT_STATUS_PRESENTATION[status].icon)
    }
  )

  it.each([
    ["accepted", "tone-success"],
    ["discussion", "tone-pending"],
    ["rejected", "tone-danger"],
    ["draft", "tone-neutral"]
  ] as const)("renders %s with the %s tone", async (status, tone) => {
    const document = await renderComponent(StatusBadge, { status })

    expect(document.querySelector(".status-badge")?.classList).toContain(tone)
  })

  it("shows a supplied label instead of the status label", async () => {
    const document = await renderComponent(StatusBadge, {
      status: "discussion",
      label: "runbook · operator"
    })

    expect(document.body.textContent).toContain("runbook · operator")
    expect(document.body.textContent).not.toContain("discussion")
  })

  it("opts out of Starlight's markdown styling so it renders the same inside prose", async () => {
    const document = await renderComponent(StatusBadge, { status: "accepted" })

    expect(document.querySelector(".status-badge")?.classList).toContain(
      "not-content"
    )
  })
})
