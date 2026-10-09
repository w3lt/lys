import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import type { ModelInventoryState } from "@/lib/store/model-runtime"
import { buildLlmInfo } from "../../support/modelFixtures"

/** Inventory with one resident model and one on disk. */
const INVENTORY: ModelInventoryState = {
  status: "ready",
  models: [buildLlmInfo("qwen3-8b", { loaded: true }), buildLlmInfo("gemma-3")]
}

/**
 * Loads a fresh application store holding an inventory, and the menu that
 * reads it.
 *
 * @param modelInventory - Inventory the store holds.
 * @returns The menu component.
 */
async function loadFreshModelMenu(modelInventory: ModelInventoryState) {
  vi.resetModules()
  const { useLysStore } = await import("@/lib/store")
  const { default: ComposerModelMenu } =
    await import("@/components/ComposerComponents/ComposerModelMenu")
  useLysStore.setState({ modelInventory })
  return ComposerModelMenu
}

/**
 * Opens a menu from its focused trigger with the keyboard.
 *
 * @param user - User-event session of the case.
 * @param trigger - Menu trigger.
 * @remarks Base UI opens menus on a pointer press that jsdom does not
 * reproduce; Enter is the supported keyboard path to the same open state.
 */
async function openMenuWithKeyboard(
  user: ReturnType<typeof userEvent.setup>,
  trigger: HTMLElement
): Promise<void> {
  trigger.focus()
  await user.keyboard("{Enter}")
}

describe("ComposerModelMenu", () => {
  it("names the weights answering the conversation on its trigger", async () => {
    const ComposerModelMenu = await loadFreshModelMenu(INVENTORY)

    render(
      <ComposerModelMenu
        label="qwen3-8b · loading"
        modelRuntime={{ status: "loading", modelKey: "qwen3-8b" }}
        onSelectModel={vi.fn()}
        selectedModelKey="qwen3-8b"
      />
    )

    expect(
      screen.getByRole("button", { name: "qwen3-8b · loading" })
    ).toHaveAttribute("aria-haspopup", "menu")
  })

  it("lists every model with its condition in words, checking the selected one", async () => {
    const ComposerModelMenu = await loadFreshModelMenu(INVENTORY)
    const user = userEvent.setup()
    render(
      <ComposerModelMenu
        label="qwen3-8b"
        modelRuntime={{ status: "loaded", modelKey: "qwen3-8b" }}
        onSelectModel={vi.fn()}
        selectedModelKey="qwen3-8b"
      />
    )

    await openMenuWithKeyboard(
      user,
      screen.getByRole("button", { name: "qwen3-8b" })
    )

    const options = screen.getAllByRole("menuitemradio")
    expect(options.map((option) => option.textContent)).toEqual([
      "qwen3-8b7B · Q4_K_M · 4.0 GBresident",
      "gemma-37B · Q4_K_M · 4.0 GB4.0 GB on disk"
    ])
    expect(
      options.map((option) => option.getAttribute("aria-checked"))
    ).toEqual(["true", "false"])
  })

  it("tags a chosen default that is not loaded as selected", async () => {
    const ComposerModelMenu = await loadFreshModelMenu(INVENTORY)
    const user = userEvent.setup()
    render(
      <ComposerModelMenu
        label="qwen3-8b"
        modelRuntime={{ status: "loaded", modelKey: "qwen3-8b" }}
        onSelectModel={vi.fn()}
        selectedModelKey="gemma-3"
      />
    )

    await openMenuWithKeyboard(
      user,
      screen.getByRole("button", { name: "qwen3-8b" })
    )

    expect(
      screen.getByRole("menuitemradio", { name: /^gemma-3/, checked: true })
    ).toHaveTextContent(/selected$/)
  })

  it("chooses the model the user picks", async () => {
    const onSelectModel = vi.fn()
    const ComposerModelMenu = await loadFreshModelMenu(INVENTORY)
    const user = userEvent.setup()
    render(
      <ComposerModelMenu
        label="qwen3-8b"
        modelRuntime={{ status: "loaded", modelKey: "qwen3-8b" }}
        onSelectModel={onSelectModel}
        selectedModelKey="qwen3-8b"
      />
    )
    await openMenuWithKeyboard(
      user,
      screen.getByRole("button", { name: "qwen3-8b" })
    )

    await user.click(screen.getByRole("menuitemradio", { name: /^gemma-3/ }))

    expect(onSelectModel).toHaveBeenCalledOnce()
    expect(onSelectModel.mock.calls[0]?.[0]).toBe("gemma-3")
  })

  it.each<ModelInventoryState>([
    { status: "unavailable" },
    { status: "failed" }
  ])(
    "points to Model settings without an inventory (%o)",
    async (modelInventory) => {
      const ComposerModelMenu = await loadFreshModelMenu(modelInventory)
      const user = userEvent.setup()
      render(
        <ComposerModelMenu
          label="no model selected"
          modelRuntime={{ status: "none" }}
          onSelectModel={vi.fn()}
          selectedModelKey={null}
        />
      )

      await openMenuWithKeyboard(
        user,
        screen.getByRole("button", { name: "no model selected" })
      )

      expect(
        screen.getByText("No model inventory · open Model settings")
      ).toBeInTheDocument()
      expect(screen.queryByRole("menuitemradio")).not.toBeInTheDocument()
    }
  )
})
