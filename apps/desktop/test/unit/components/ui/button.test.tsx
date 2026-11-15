import { createRef, type FormEvent } from "react"
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

  it("exposes its variant and size on the host, `default` when omitted", () => {
    render(
      <>
        <Button>Save</Button>
        <Button size="icon-xs" title="Settings" variant="ghost" />
      </>
    )

    const save = screen.getByRole("button", { name: "Save" })
    const settings = screen.getByRole("button", { name: "Settings" })
    expect(save).toHaveAttribute("data-variant", "default")
    expect(save).toHaveAttribute("data-size", "default")
    expect(settings).toHaveAttribute("data-variant", "ghost")
    expect(settings).toHaveAttribute("data-size", "icon-xs")
  })

  it("sizes the icon of a text or back action to its mono text, at any size", () => {
    render(
      <>
        <Button variant="text">add variable</Button>
        <Button size="lg" variant="back">
          agents
        </Button>
      </>
    )

    for (const name of ["add variable", "agents"]) {
      const iconSizes = screen
        .getByRole("button", { name })
        .className.split(" ")
        .filter((utility) => utility.startsWith("[&_svg:not"))
      expect(iconSizes).toEqual(["[&_svg:not([class*='size-'])]:size-3"])
    }
  })

  it("keeps native button behavior in a frameless variant", async () => {
    const onClick = vi.fn()
    const user = userEvent.setup()
    render(
      <Button onClick={onClick} variant="back">
        agents
      </Button>
    )

    await user.click(screen.getByRole("button", { name: "agents" }))
    await user.keyboard("{Enter}")

    expect(screen.getByRole("button", { name: "agents" }).tagName).toBe(
      "BUTTON"
    )
    expect(onClick).toHaveBeenCalledTimes(2)
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
    const onSubmit = vi.fn((event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
    })
    const user = userEvent.setup()
    render(
      <form onSubmit={onSubmit}>
        <Button type="submit">Create</Button>
      </form>
    )

    await user.click(screen.getByRole("button", { name: "Create" }))

    expect(onSubmit).toHaveBeenCalledOnce()
  })
})
