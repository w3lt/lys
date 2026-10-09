import { createRef } from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { Button } from "@/components/ui/button"

describe("Button", () => {
  it("renders a native button that forwards its props, content, and ref", () => {
    const ref = createRef<HTMLElement>()
    render(
      <Button aria-pressed ref={ref} title="Pin" variant="outline">
        Pin
      </Button>
    )

    const button = screen.getByRole("button", { name: "Pin", pressed: true })
    expect(button.tagName).toBe("BUTTON")
    expect(button).toHaveAttribute("title", "Pin")
    expect(ref.current).toBe(button)
  })

  it("activates once per press by pointer, Enter, or Space", async () => {
    const onClick = vi.fn()
    const user = userEvent.setup()
    render(<Button onClick={onClick}>Send</Button>)

    await user.click(screen.getByRole("button", { name: "Send" }))
    await user.keyboard("{Enter}")
    await user.keyboard(" ")

    expect(onClick).toHaveBeenCalledTimes(3)
  })

  it("neither activates nor takes focus while disabled", async () => {
    const onClick = vi.fn()
    const user = userEvent.setup()
    render(
      <Button disabled onClick={onClick}>
        Send
      </Button>
    )

    await user.click(screen.getByRole("button", { name: "Send" }))
    await user.tab()

    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled()
    expect(onClick).not.toHaveBeenCalled()
    expect(document.body).toHaveFocus()
  })

  it("submits its form when it is a submit button", async () => {
    const onSubmit = vi.fn((event: SubmitEvent) => event.preventDefault())
    const user = userEvent.setup()
    render(
      <form onSubmit={(event) => onSubmit(event.nativeEvent as SubmitEvent)}>
        <Button type="submit">Create</Button>
      </form>
    )

    await user.click(screen.getByRole("button", { name: "Create" }))

    expect(onSubmit).toHaveBeenCalledOnce()
  })
})
