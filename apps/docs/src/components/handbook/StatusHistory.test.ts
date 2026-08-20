import { describe, expect, it } from "vitest"
import StatusHistory from "./StatusHistory.astro"
import { renderComponent } from "@/test/render"

const transitions = [
  { date: "2026-06-11", status: "draft" as const, note: "Opened." },
  { date: "2026-08-02", status: "accepted" as const, note: "Approved." }
]

describe("StatusHistory", () => {
  it("renders one row per transition", async () => {
    const document = await renderComponent(StatusHistory, { transitions })

    expect(document.querySelectorAll("tbody tr")).toHaveLength(2)
  })

  it("keeps the authored order, oldest first", async () => {
    const document = await renderComponent(StatusHistory, { transitions })

    expect(
      [...document.querySelectorAll(".date")].map((node) => node.textContent)
    ).toEqual(["2026-06-11", "2026-08-02"])
  })

  it("names each column so a cell keeps its meaning", async () => {
    const document = await renderComponent(StatusHistory, { transitions })
    const headers = [...document.querySelectorAll("th")]

    expect(headers.map((node) => node.textContent)).toEqual([
      "Date",
      "Status",
      "Note"
    ])
    expect(headers.every((node) => node.getAttribute("scope") === "col")).toBe(
      true
    )
  })

  it("shows each transition's status as text, not colour alone", async () => {
    const document = await renderComponent(StatusHistory, { transitions })

    expect(document.body.textContent).toContain("draft")
    expect(document.body.textContent).toContain("accepted")
  })

  it("renders an empty history as an empty table body rather than failing", async () => {
    const document = await renderComponent(StatusHistory, { transitions: [] })

    expect(document.querySelectorAll("tbody tr")).toHaveLength(0)
  })
})
