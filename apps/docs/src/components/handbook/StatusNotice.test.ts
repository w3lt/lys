import { describe, expect, it } from "vitest"
import StatusNotice from "./StatusNotice.astro"
import { renderComponent } from "@/test/render"

describe("StatusNotice", () => {
  it("renders nothing for a current decision", async () => {
    const document = await renderComponent(StatusNotice, {
      kind: "decision",
      status: "accepted"
    })

    expect(document.querySelector("aside")).toBeNull()
  })

  it("renders nothing for an implemented proposal", async () => {
    const document = await renderComponent(StatusNotice, {
      kind: "proposal",
      status: "implemented"
    })

    expect(document.querySelector("aside")).toBeNull()
  })

  it("warns that an accepted proposal is not current architecture", async () => {
    const document = await renderComponent(StatusNotice, {
      kind: "proposal",
      status: "accepted"
    })

    expect(document.body.textContent).toContain("Approved future change")
    expect(document.body.textContent).toContain(
      "not describe current architecture"
    )
  })

  it("names the notice region after its heading", async () => {
    const document = await renderComponent(StatusNotice, {
      kind: "decision",
      status: "superseded"
    })

    expect(document.querySelector("aside")?.getAttribute("aria-label")).toBe(
      "Historical document"
    )
  })

  it("puts the record's own reason in front of the standing explanation", async () => {
    const document = await renderComponent(StatusNotice, {
      kind: "decision",
      status: "superseded",
      reason: "Superseded by ADR-0007."
    })

    const body = document.body.textContent ?? ""

    expect(body).toContain("Superseded by ADR-0007.")
    expect(body.indexOf("Superseded by ADR-0007.")).toBeLessThan(
      body.indexOf("preserved as evidence")
    )
  })

  it("hides the status glyph, which repeats the heading", async () => {
    const document = await renderComponent(StatusNotice, {
      kind: "proposal",
      status: "rejected"
    })

    expect(document.querySelector(".glyph")?.getAttribute("aria-hidden")).toBe(
      "true"
    )
  })
})
