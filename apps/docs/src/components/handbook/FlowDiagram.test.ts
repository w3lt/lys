import { describe, expect, it } from "vitest"
import FlowDiagram from "./FlowDiagram.astro"
import { renderComponent } from "@/test/render"

const diagram = {
  title: "Diagram · session message flow",
  path: [
    { label: "Desktop", detail: "user intent" },
    { label: "Tauri host", detail: "command" }
  ],
  outputs: [{ label: "Event bus", detail: "typed events" }],
  caption: "A user message enters through the host and is persisted first."
}

describe("FlowDiagram", () => {
  it("renders the primary path as an ordered list, preserving direction", async () => {
    const document = await renderComponent(FlowDiagram, diagram)

    expect(
      [...document.querySelectorAll("ol > li .label")].map((n) => n.textContent)
    ).toEqual(["Desktop", "Tauri host"])
  })

  it("renders the fan-out as an unordered list, which has no sequence", async () => {
    const document = await renderComponent(FlowDiagram, diagram)

    expect(
      [...document.querySelectorAll("ul > li .label")].map((n) => n.textContent)
    ).toEqual(["Event bus"])
  })

  it("carries the meaning in a caption, not only in the picture", async () => {
    const document = await renderComponent(FlowDiagram, diagram)

    expect(document.querySelector("figcaption")?.textContent).toBe(
      diagram.caption
    )
  })

  it("hides the connecting arrows, which carry no text meaning", async () => {
    const document = await renderComponent(FlowDiagram, diagram)

    for (const arrow of document.querySelectorAll(".arrow, .connector")) {
      expect(arrow.getAttribute("aria-hidden")).toBe("true")
    }
  })

  it("draws no arrow after the last participant", async () => {
    const document = await renderComponent(FlowDiagram, diagram)

    expect(document.querySelectorAll(".arrow")).toHaveLength(
      diagram.path.length - 1
    )
  })

  it("keeps every participant's detail as selectable text", async () => {
    const document = await renderComponent(FlowDiagram, diagram)

    expect(document.body.textContent).toContain("user intent")
    expect(document.body.textContent).toContain("typed events")
  })
})
