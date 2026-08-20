import { describe, expect, it } from "vitest"
import StateSummary from "./StateSummary.astro"
import { renderComponent } from "@/test/render"

const records = [
  {
    identifier: "ADR-0007",
    title: "Credentials reach providers only as host-issued handles",
    status: "accepted" as const,
    href: "/decisions/adr-0007/",
    date: "2026-07-24",
    areas: []
  }
]

const panel = {
  title: "Recent decisions",
  indexLabel: "All decisions",
  indexHref: "/decisions/"
}

describe("StateSummary", () => {
  it("names the section after its own heading", async () => {
    const document = await renderComponent(StateSummary, { ...panel, records })
    const heading = document.querySelector("h3")

    expect(heading?.textContent).toBe("Recent decisions")
    expect(
      document.querySelector("section")?.getAttribute("aria-labelledby")
    ).toBe(heading?.id)
  })

  it("links each record and shows its status", async () => {
    const document = await renderComponent(StateSummary, { ...panel, records })

    expect(document.querySelector("li a")?.getAttribute("href")).toBe(
      "/decisions/adr-0007/"
    )
    expect(document.querySelector("li")?.textContent).toContain("accepted")
  })

  it("keeps the index link outside the row links, so no link nests in another", async () => {
    const document = await renderComponent(StateSummary, { ...panel, records })

    for (const link of document.querySelectorAll("a")) {
      expect(link.querySelector("a")).toBeNull()
    }
  })

  it("shows an empty state rather than an empty table when nothing is recorded", async () => {
    const document = await renderComponent(StateSummary, {
      ...panel,
      records: []
    })

    expect(document.querySelector("ul")).toBeNull()
    expect(document.querySelector(".empty")?.textContent).toBe(
      "No records yet."
    )
  })

  it("still offers the index link when the register is empty", async () => {
    const document = await renderComponent(StateSummary, {
      ...panel,
      records: []
    })

    expect(document.querySelector("header a")?.getAttribute("href")).toBe(
      "/decisions/"
    )
  })
})
