import type { ComponentProps } from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import ModelRow from "@/components/SettingsViewComponents/ModelRow"
import { buildModelDescriptor } from "@/lib/models/inventory"
import { buildLlmInfo } from "../../support/modelFixtures"

/** Model resident in LM Studio. */
const RESIDENT = buildModelDescriptor(
  buildLlmInfo("qwen3-8b", { loaded: true })
)

/** Model on disk only. */
const ON_DISK = buildModelDescriptor(buildLlmInfo("gemma-3"))

/**
 * Renders one row in a list with spies for every action.
 *
 * @param props - Row facts the case varies.
 * @returns The action spies.
 */
function startModelRow(props: Partial<ComponentProps<typeof ModelRow>> = {}) {
  const actions = {
    onSelect: vi.fn(),
    onLoad: vi.fn(() => Promise.resolve()),
    onUnload: vi.fn(() => Promise.resolve()),
    onTest: vi.fn(() => Promise.resolve())
  }
  render(
    <ul>
      <ModelRow
        disabled={false}
        isDefault={false}
        model={ON_DISK}
        modelRuntime={{ status: "loaded", modelKey: "qwen3-8b" }}
        {...actions}
        {...props}
      />
    </ul>
  )
  return actions
}

describe("ModelRow", () => {
  it("makes the model the default without loading it", async () => {
    const actions = startModelRow()
    const user = userEvent.setup()

    const choice = screen.getByRole("button", {
      pressed: false,
      name: /^gemma-3/
    })
    expect(choice).toHaveTextContent(
      "gemma-37B · Q4_K_M · 4.0 GB4.0 GB on disk"
    )
    await user.click(choice)

    expect(actions.onSelect).toHaveBeenCalledExactlyOnceWith("gemma-3")
    expect(actions.onLoad).not.toHaveBeenCalled()
  })

  it("marks the default model as pressed and labelled default", () => {
    startModelRow({ isDefault: true })

    expect(
      screen.getByRole("button", { pressed: true, name: /^gemma-3default/ })
    ).toBeInTheDocument()
  })

  it("loads a model on disk and unloads a resident one", async () => {
    const onDisk = startModelRow()
    const user = userEvent.setup()

    await user.click(screen.getByRole("button", { name: "Load gemma-3" }))
    expect(onDisk.onLoad).toHaveBeenCalledExactlyOnceWith("gemma-3")

    const resident = startModelRow({ model: RESIDENT })
    await user.click(screen.getByRole("button", { name: "Unload qwen3-8b" }))
    expect(resident.onUnload).toHaveBeenCalledExactlyOnceWith("qwen3-8b")
  })

  it("tests whether the model is loaded", async () => {
    const actions = startModelRow({ model: RESIDENT })
    const user = userEvent.setup()

    await user.click(screen.getByRole("button", { name: "Test qwen3-8b" }))

    expect(actions.onTest).toHaveBeenCalledExactlyOnceWith("qwen3-8b")
  })

  it.each([
    [100, true],
    [101, false]
  ])(
    "offers testing a %d-character key only when the health check accepts it",
    (keyLength, isTestable) => {
      const modelKey = "m".repeat(keyLength)
      startModelRow({ model: buildModelDescriptor(buildLlmInfo(modelKey)) })

      expect(
        screen.getByRole("button", { name: `Test ${modelKey}` })
      ).toHaveProperty("disabled", !isTestable)
    }
  )

  it("disables its actions, but not the default choice, while requests cannot be made", async () => {
    const actions = startModelRow({ disabled: true })
    const user = userEvent.setup()

    expect(screen.getByRole("button", { name: "Test gemma-3" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Load gemma-3" })).toBeDisabled()
    await user.click(screen.getByRole("button", { name: /^gemma-3/ }))

    expect(actions.onSelect).toHaveBeenCalledOnce()
  })
})
