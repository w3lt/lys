import { describe, expect, it } from "vitest"
import Procedure from "./Procedure.astro"
import { renderComponent } from "@/test/render"

const steps = [
  {
    title: "Stop Lys.",
    command: "lys diagnostics status",
    note: "Confirm no backend runs."
  },
  { title: "Copy the store.", note: "This copy is the only rollback path." }
]

describe("Procedure", () => {
  it("renders the steps as an ordered list so their sequence is announced", async () => {
    const document = await renderComponent(Procedure, { steps })

    expect(document.querySelectorAll("ol > li")).toHaveLength(2)
  })

  it("keeps the authored order", async () => {
    const document = await renderComponent(Procedure, { steps })

    expect(document.querySelector("li .title")?.textContent).toBe("Stop Lys.")
  })

  it("renders a command only for the step that has one", async () => {
    const document = await renderComponent(Procedure, { steps })
    const items = [...document.querySelectorAll("li")]

    expect(items[0]?.querySelector("code")?.textContent).toBe(
      "lys diagnostics status"
    )
    expect(items[1]?.querySelector("code")).toBeNull()
  })

  it("always renders the step's note", async () => {
    const document = await renderComponent(Procedure, { steps })

    expect(
      [...document.querySelectorAll(".note")].map((n) => n.textContent)
    ).toEqual([
      "Confirm no backend runs.",
      "This copy is the only rollback path."
    ])
  })

  it("hides the visible ordinal, which repeats the list position", async () => {
    const document = await renderComponent(Procedure, { steps })

    expect(
      document.querySelector(".ordinal")?.getAttribute("aria-hidden")
    ).toBe("true")
  })

  it("renders an empty procedure as an empty list rather than failing", async () => {
    const document = await renderComponent(Procedure, { steps: [] })

    expect(document.querySelectorAll("li")).toHaveLength(0)
  })
})
