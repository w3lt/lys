import { describe, expect, it } from "vitest"
import FieldList from "./FieldList.astro"
import { renderComponent } from "@/test/render"

const fields = [
  {
    name: "eventId",
    type: "string",
    presence: "required",
    description: "Monotonic identifier of this event within its session."
  },
  {
    name: "reason",
    type: "string",
    presence: "optional",
    description: "Human-readable explanation, present only on failures."
  }
]

describe("FieldList", () => {
  it("pairs each description with its complete signature", async () => {
    const document = await renderComponent(FieldList, { fields })
    const [term] = document.querySelectorAll("dt")

    expect(term?.textContent).toContain("eventId")
    expect(term?.textContent).toContain("string")
    expect(term?.textContent).toContain("required")
  })

  it("renders one term and one description per field", async () => {
    const document = await renderComponent(FieldList, { fields })

    expect(document.querySelectorAll("dt")).toHaveLength(2)
    expect(document.querySelectorAll("dd")).toHaveLength(2)
  })

  it("distinguishes a required field from an optional one", async () => {
    const document = await renderComponent(FieldList, { fields })

    expect(
      [...document.querySelectorAll(".presence")].map((n) => n.textContent)
    ).toEqual(["required", "optional"])
  })

  it("renders an empty contract as an empty list rather than failing", async () => {
    const document = await renderComponent(FieldList, { fields: [] })

    expect(document.querySelectorAll("dt")).toHaveLength(0)
  })
})
