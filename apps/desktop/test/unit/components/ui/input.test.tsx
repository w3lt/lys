import { createRef } from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { Input } from "@/components/ui/input"

describe("Input", () => {
  it("renders a native input that forwards its attributes, value, and ref", () => {
    const ref = createRef<HTMLInputElement>()
    render(
      <Input
        aria-invalid
        aria-label="name"
        onChange={vi.fn()}
        ref={ref}
        type="text"
        value="Reviewer"
      />
    )

    const input = screen.getByRole("textbox", { name: "name" })
    expect(input.tagName).toBe("INPUT")
    expect(input).toHaveValue("Reviewer")
    expect(input).toBeInvalid()
    expect(ref.current).toBe(input)
  })

  it("reports each edit", async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<Input aria-label="name" onChange={onChange} />)

    await user.type(screen.getByRole("textbox", { name: "name" }), "ab")

    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it("keeps its text while read-only", async () => {
    const user = userEvent.setup()
    render(<Input aria-label="name" defaultValue="Fixed" readOnly />)

    await user.type(screen.getByRole("textbox", { name: "name" }), "!")

    expect(screen.getByRole("textbox", { name: "name" })).toHaveValue("Fixed")
  })
})
