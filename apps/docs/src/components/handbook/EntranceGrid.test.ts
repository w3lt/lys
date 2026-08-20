import { describe, expect, it } from "vitest"
import EntranceGrid from "./EntranceGrid.astro"
import { renderComponent } from "@/test/render"

const entrances = [
  {
    kicker: "Architecture",
    title: "Understand Lys",
    description: "How the parts divide responsibility.",
    href: "/architecture/backend/"
  },
  {
    kicker: "Decisions",
    title: "Review decisions",
    description: "Why durable decisions were made.",
    href: "/decisions/"
  }
]

describe("EntranceGrid", () => {
  it("renders one link per entrance, addressed to its href", async () => {
    const document = await renderComponent(EntranceGrid, { entrances })

    expect(
      [...document.querySelectorAll("a")].map((a) => a.getAttribute("href"))
    ).toEqual(["/architecture/backend/", "/decisions/"])
  })

  it("shows the kicker, title, and description of each entrance", async () => {
    const document = await renderComponent(EntranceGrid, { entrances })
    const first = document.querySelector("a")?.textContent ?? ""

    expect(first).toContain("Architecture")
    expect(first).toContain("Understand Lys")
    expect(first).toContain("How the parts divide responsibility.")
  })

  it("nests no control inside a card, so each card is one target", async () => {
    const document = await renderComponent(EntranceGrid, { entrances })

    for (const link of document.querySelectorAll("a")) {
      expect(link.querySelector("a, button")).toBeNull()
    }
  })

  it("names the region so it can be skipped", async () => {
    const document = await renderComponent(EntranceGrid, { entrances })

    expect(document.querySelector("nav")?.getAttribute("aria-label")).toBe(
      "Where to start"
    )
  })
})
