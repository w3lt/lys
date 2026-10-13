import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import ComposerPlusMenu from "@/components/ComposerComponents/ComposerPlusMenu"
import { openMenuWithKeyboard } from "../../support/rendering"

describe("ComposerPlusMenu", () => {
  it("says on its trigger whether files are attached", () => {
    const { rerender } = render(
      <ComposerPlusMenu
        disabled={false}
        hasAttachments={false}
        onAttachFile={vi.fn()}
      />
    )

    expect(
      screen.getByRole("button", { name: "Add to this message" })
    ).toBeInTheDocument()

    rerender(
      <ComposerPlusMenu
        disabled={false}
        hasAttachments
        onAttachFile={vi.fn()}
      />
    )

    expect(
      screen.getByRole("button", {
        name: "Add to this message; files are attached"
      })
    ).toBeInTheDocument()
  })

  it("attaches a file once when that action is chosen", async () => {
    const onAttachFile = vi.fn()
    const user = userEvent.setup()
    render(
      <ComposerPlusMenu
        disabled={false}
        hasAttachments={false}
        onAttachFile={onAttachFile}
      />
    )
    await openMenuWithKeyboard(
      user,
      screen.getByRole("button", { name: /^Add to this message/ })
    )

    await user.click(screen.getByRole("menuitem", { name: "Attach a file" }))

    expect(onAttachFile).toHaveBeenCalledOnce()
  })

  it("lists the planned actions as disabled and marked soon", async () => {
    const user = userEvent.setup()
    render(
      <ComposerPlusMenu
        disabled={false}
        hasAttachments={false}
        onAttachFile={vi.fn()}
      />
    )
    await openMenuWithKeyboard(
      user,
      screen.getByRole("button", { name: /^Add to this message/ })
    )

    for (const label of ["Connect an app", "Plugins", "Saved prompts"]) {
      const action = screen.getByRole("menuitem", { name: `${label}soon` })
      expect(action).toHaveAttribute("aria-disabled", "true")
    }
  })

  it("cannot be opened while disabled", async () => {
    const user = userEvent.setup()
    render(
      <ComposerPlusMenu
        disabled
        hasAttachments={false}
        onAttachFile={vi.fn()}
      />
    )

    const trigger = screen.getByRole("button", { name: "Add to this message" })
    await user.click(trigger)
    await openMenuWithKeyboard(
      user,
      screen.getByRole("button", { name: /^Add to this message/ })
    )

    expect(trigger).toBeDisabled()
    expect(screen.queryByRole("menu")).not.toBeInTheDocument()
  })
})
