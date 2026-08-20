import { describe, expect, it } from "vitest"
import DocumentMeta from "./DocumentMeta.astro"
import { renderComponent } from "@/test/render"

const entries = [
  { label: "Status", value: "Accepted" },
  { label: "Decided", value: "2026-07-24" }
]

describe("DocumentMeta", () => {
  it("pairs each value with its own label", async () => {
    const document = await renderComponent(DocumentMeta, { entries })
    const terms = [...document.querySelectorAll("dt")].map((n) => n.textContent)
    const values = [...document.querySelectorAll("dd")].map(
      (n) => n.textContent
    )

    expect(terms).toEqual(["Status", "Decided"])
    expect(values).toEqual(["Accepted", "2026-07-24"])
  })

  it("preserves the authored order", async () => {
    const document = await renderComponent(DocumentMeta, { entries })

    expect(document.querySelector("dt")?.textContent).toBe("Status")
  })

  it("names the group so it is distinguishable from surrounding prose", async () => {
    const document = await renderComponent(DocumentMeta, {
      entries,
      label: "Decision metadata"
    })

    expect(document.querySelector("dl")?.getAttribute("aria-label")).toBe(
      "Decision metadata"
    )
  })

  it("falls back to a generic group name when none is supplied", async () => {
    const document = await renderComponent(DocumentMeta, { entries })

    expect(document.querySelector("dl")?.getAttribute("aria-label")).toBe(
      "Document metadata"
    )
  })

  it("renders an empty list as an empty group rather than failing", async () => {
    const document = await renderComponent(DocumentMeta, { entries: [] })

    expect(document.querySelectorAll("dt")).toHaveLength(0)
  })
})
