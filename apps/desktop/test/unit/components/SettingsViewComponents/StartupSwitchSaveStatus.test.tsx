import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import StartupSwitchSaveStatus from "@/components/SettingsViewComponents/StartupSwitchSaveStatus"
import type { RuntimeAutoStartSaveState } from "@/lib/store/runtime-autostart-settings"

/** No save of the switches has run. */
const NOT_SAVED: RuntimeAutoStartSaveState = Object.freeze({ status: "idle" })

/** A save of the switches is running. */
const SAVING: RuntimeAutoStartSaveState = Object.freeze({ status: "saving" })

/** The latest save of the switches succeeded. */
const SAVED: RuntimeAutoStartSaveState = Object.freeze({ status: "saved" })

/** The latest save of the switches failed. */
const FAILED: RuntimeAutoStartSaveState = Object.freeze({ status: "failed" })

/** What the status says after a failed save. */
const FAILED_LINE =
  "Lys couldn't save the startup switches. The next launch follows the switches last saved; changing a switch tries again."

describe("StartupSwitchSaveStatus", () => {
  it.each([NOT_SAVED, SAVING, SAVED])(
    "stays empty while the save is $status",
    (autoStartSave) => {
      render(<StartupSwitchSaveStatus autoStartSave={autoStartSave} />)

      expect(
        screen.getByRole("status", { name: "Startup switches save" })
      ).toBeEmptyDOMElement()
    }
  )

  it("says the next launch follows the switches last saved when a save fails", () => {
    render(<StartupSwitchSaveStatus autoStartSave={FAILED} />)

    expect(
      screen.getByRole("status", { name: "Startup switches save" })
    ).toHaveTextContent(FAILED_LINE)
  })

  it("announces a failure politely and clears it once a newer save runs, without moving focus", () => {
    const { rerender } = render(
      <>
        <button type="button">Elsewhere</button>
        <StartupSwitchSaveStatus autoStartSave={SAVING} />
      </>
    )
    const status = screen.getByRole("status", {
      name: "Startup switches save"
    })
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" })
    elsewhere.focus()

    rerender(
      <>
        <button type="button">Elsewhere</button>
        <StartupSwitchSaveStatus autoStartSave={FAILED} />
      </>
    )
    const afterFailure = status.textContent
    rerender(
      <>
        <button type="button">Elsewhere</button>
        <StartupSwitchSaveStatus autoStartSave={SAVING} />
      </>
    )
    const whileSavingAgain = status.textContent
    rerender(
      <>
        <button type="button">Elsewhere</button>
        <StartupSwitchSaveStatus autoStartSave={SAVED} />
      </>
    )

    expect(afterFailure).toBe(FAILED_LINE)
    expect(whileSavingAgain).toBe("")
    expect(screen.getByRole("status", { name: "Startup switches save" })).toBe(
      status
    )
    expect(status).toHaveAttribute("aria-live", "polite")
    expect(status).toBeEmptyDOMElement()
    expect(elsewhere).toHaveFocus()
  })
})
