import { describe, expect, it } from "vitest"
import RelatedDocuments from "./RelatedDocuments.astro"
import { renderComponent } from "@/test/render"

const documents = [
  {
    kind: "ADR",
    label: "ADR-0007 — Credential handles",
    href: "/decisions/adr-0007/"
  },
  { kind: "Reference", label: "SSE events", href: "/reference/sse-events/" }
]

describe("RelatedDocuments", () => {
  it("renders one link per document, addressed to its href", async () => {
    const document = await renderComponent(RelatedDocuments, { documents })
    const links = [...document.querySelectorAll("a")]

    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/decisions/adr-0007/",
      "/reference/sse-events/"
    ])
  })

  it("names each link with its kind followed by its title", async () => {
    const document = await renderComponent(RelatedDocuments, { documents })

    expect(document.querySelector("a")?.textContent).toBe(
      "ADRADR-0007 — Credential handles"
    )
  })

  it("nests no control inside a card, so each card is one target", async () => {
    const document = await renderComponent(RelatedDocuments, { documents })

    for (const link of document.querySelectorAll("a")) {
      expect(link.querySelector("a, button, input")).toBeNull()
    }
  })

  it("presents the documents as a list so their count is announced", async () => {
    const document = await renderComponent(RelatedDocuments, { documents })

    expect(document.querySelectorAll("nav > ul > li")).toHaveLength(2)
  })

  it("names the region so it can be skipped", async () => {
    const document = await renderComponent(RelatedDocuments, {
      documents,
      label: "Related decisions"
    })

    expect(document.querySelector("nav")?.getAttribute("aria-label")).toBe(
      "Related decisions"
    )
  })
})
