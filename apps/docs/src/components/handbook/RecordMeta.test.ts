import { describe, expect, it } from "vitest"
import RecordMeta from "./RecordMeta.astro"
import { renderComponent } from "@/test/render"

const readTerms = (document: Document): readonly (string | null)[] =>
  [...document.querySelectorAll("dt")].map((node) => node.textContent)

describe("RecordMeta", () => {
  it("shows a decision's own fields", async () => {
    const document = await renderComponent(RecordMeta, {
      frontmatter: {
        status: "accepted",
        decided: "2026-07-24",
        areas: ["backend", "security"],
        supersedes: "ADR-0003"
      }
    })

    expect(readTerms(document)).toEqual([
      "Status",
      "Decided",
      "Areas",
      "Supersedes"
    ])
  })

  it("shows a proposal's own fields", async () => {
    const document = await renderComponent(RecordMeta, {
      frontmatter: {
        status: "accepted",
        author: "Welt",
        created: "2026-06-11",
        updated: "2026-08-02",
        areas: ["backend"]
      }
    })

    expect(readTerms(document)).toEqual([
      "Status",
      "Author",
      "Created",
      "Updated",
      "Areas"
    ])
  })

  it("shows a reference page's contract identity", async () => {
    const document = await renderComponent(RecordMeta, {
      frontmatter: {
        stability: "stable",
        contract: "@lys/protocol",
        contractVersion: "v1"
      }
    })

    expect(readTerms(document)).toEqual(["Stability", "Contract", "Version"])
  })

  it("omits a field the record does not declare rather than showing it empty", async () => {
    const document = await renderComponent(RecordMeta, {
      frontmatter: { status: "draft" }
    })

    expect(readTerms(document)).toEqual(["Status"])
  })

  it("joins the affected areas into one readable value", async () => {
    const document = await renderComponent(RecordMeta, {
      frontmatter: { areas: ["backend", "protocol", "desktop"] }
    })

    expect(document.querySelector("dd")?.textContent).toBe(
      "backend, protocol, desktop"
    )
  })

  it("renders an empty group when the record declares no metadata", async () => {
    const document = await renderComponent(RecordMeta, { frontmatter: {} })

    expect(document.querySelectorAll("dt")).toHaveLength(0)
  })
})
