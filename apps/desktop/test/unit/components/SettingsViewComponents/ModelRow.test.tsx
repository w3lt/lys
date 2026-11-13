import type { ComponentProps } from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import ModelRow from "@/components/SettingsViewComponents/ModelRow"
import { buildLlmInfo } from "../../support/modelFixtures"

/**
 * Renders one row in a list with a spy for its selection request.
 *
 * @param props - Row facts the case varies.
 * @returns The selection spy.
 */
function startModelRow(props: Partial<ComponentProps<typeof ModelRow>> = {}) {
  const onSelectModel = vi.fn()
  render(
    <ul>
      <ModelRow
        columnValue="4.0 GB"
        isDefault={false}
        isLoading={false}
        isSelected={false}
        model={buildLlmInfo("google/gemma-3:4b")}
        onSelectModel={onSelectModel}
        {...props}
      />
    </ul>
  )
  return onSelectModel
}

describe("ModelRow", () => {
  it("asks to show its model when pressed", async () => {
    const onSelectModel = startModelRow()
    const user = userEvent.setup()

    await user.click(screen.getByRole("button"))

    expect(onSelectModel).toHaveBeenCalledExactlyOnceWith("google/gemma-3:4b")
  })

  it("shows the key, then its column value, and marks only the selected row as current", () => {
    startModelRow()

    expect(screen.getByRole("button")).toHaveTextContent(
      /^google\/gemma-3:4b4\.0 GB$/
    )
    expect(screen.getByRole("button")).not.toHaveAttribute("aria-current")
  })

  it("states in words that its model is the default, loading, and selected", () => {
    startModelRow({ isDefault: true, isLoading: true, isSelected: true })

    expect(screen.getByRole("button")).toHaveTextContent(
      /^google\/gemma-3:4bDefaultLoading…4\.0 GB$/
    )
    expect(screen.getByRole("button")).toHaveAttribute("aria-current", "true")
  })
})
