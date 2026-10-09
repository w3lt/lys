import { createRef } from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { Textarea } from "@/components/ui/textarea"

describe("Textarea", () => {
  it("renders a native multiline field that forwards its attributes, value, and ref", () => {
    const ref = createRef<HTMLTextAreaElement>()
    render(
      <Textarea
        aria-label="Message Lys"
        onChange={vi.fn()}
        placeholder="Say something"
        ref={ref}
        value={"Line one\nLine two"}
      />
    )

    const field = screen.getByRole("textbox", { name: "Message Lys" })
    expect(field.tagName).toBe("TEXTAREA")
    expect(field).toHaveValue("Line one\nLine two")
    expect(field).toHaveAttribute("placeholder", "Say something")
    expect(ref.current).toBe(field)
  })

  it("accepts no text while disabled", async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<Textarea aria-label="Message Lys" disabled onChange={onChange} />)

    await user.type(screen.getByRole("textbox", { name: "Message Lys" }), "x")

    expect(onChange).not.toHaveBeenCalled()
  })
})
