import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"

/**
 * Renders a menu with one action, one disabled action, and two radio items.
 *
 * @param actions - Spies for the action and the radio selection.
 */
function renderMenu(actions: {
  readonly onAttach: () => void
  readonly onValueChange: (value: string) => void
}): void {
  render(
    <DropdownMenu>
      <DropdownMenuTrigger>Add</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onClick={actions.onAttach}>Attach</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>later</DropdownMenuLabel>
          <DropdownMenuItem disabled>Plugins</DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuRadioGroup
          onValueChange={actions.onValueChange}
          value="qwen"
        >
          <DropdownMenuRadioItem value="qwen">qwen</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="gemma">gemma</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Opens the menu from its focused trigger with the keyboard.
 *
 * @param user - User-event session of the case.
 * @remarks Base UI opens menus on a pointer press that jsdom does not
 * reproduce; Enter is the supported keyboard path to the same open state.
 */
async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  screen.getByRole("button", { name: "Add" }).focus()
  await user.keyboard("{Enter}")
}

describe("DropdownMenu", () => {
  it("opens a menu of items from its trigger, which reports the open state", async () => {
    const user = userEvent.setup()
    renderMenu({ onAttach: vi.fn(), onValueChange: vi.fn() })
    const trigger = screen.getByRole("button", { name: "Add" })
    expect(trigger).toHaveAttribute("aria-haspopup", "menu")
    expect(trigger).toHaveAttribute("aria-expanded", "false")

    await openMenu(user)

    expect(trigger).toHaveAttribute("aria-expanded", "true")
    const menu = screen.getByRole("menu")
    expect(
      within(menu).getByRole("menuitem", { name: "Attach" })
    ).toBeInTheDocument()
    expect(within(menu).getByRole("separator")).toBeInTheDocument()
    expect(
      within(menu).getByRole("menuitem", { name: "Plugins" })
    ).toHaveAttribute("aria-disabled", "true")
  })

  it("runs a chosen item once and closes, returning focus to the trigger", async () => {
    const onAttach = vi.fn()
    const user = userEvent.setup()
    renderMenu({ onAttach, onValueChange: vi.fn() })
    await openMenu(user)

    await user.click(screen.getByRole("menuitem", { name: "Attach" }))

    expect(onAttach).toHaveBeenCalledOnce()
    expect(screen.queryByRole("menu")).toBeNull()
    expect(screen.getByRole("button", { name: "Add" })).toHaveFocus()
  })

  it("checks the selected radio item and proposes another", async () => {
    const onValueChange = vi.fn()
    const user = userEvent.setup()
    renderMenu({ onAttach: vi.fn(), onValueChange })
    await openMenu(user)

    expect(screen.getByRole("menuitemradio", { name: "qwen" })).toHaveAttribute(
      "aria-checked",
      "true"
    )
    await user.click(screen.getByRole("menuitemradio", { name: "gemma" }))

    expect(onValueChange.mock.calls[0]?.[0]).toBe("gemma")
  })

  it("closes on Escape and returns focus to the trigger", async () => {
    const user = userEvent.setup()
    renderMenu({ onAttach: vi.fn(), onValueChange: vi.fn() })
    await openMenu(user)

    await user.keyboard("{Escape}")

    expect(screen.queryByRole("menu")).toBeNull()
    expect(screen.getByRole("button", { name: "Add" })).toHaveFocus()
  })
})
