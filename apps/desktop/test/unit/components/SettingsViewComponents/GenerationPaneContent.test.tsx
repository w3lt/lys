import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import type { GenerationSettings } from "@/lib/store/settings"
import { initialSettingsState } from "@/lib/store/settings"
import { startBackendFake } from "../../support/backendFake"
import { startNativeHostFake } from "../../support/nativeHostFake"
import {
  buildInventoryRoute,
  INVENTORY_ROUTE,
  loadFreshSettingsView
} from "../../support/settingsViewFixtures"
import { waitForMicrotasks } from "../../support/settlement"

/**
 * Starts a native host that keeps the settings document it is given and
 * records every successful save.
 *
 * @param save - Result of each save; throwing fails it.
 * @returns The arguments of each successful save, in order.
 */
function startSettingsHost(save: () => void = () => undefined) {
  const saves: unknown[] = []
  startNativeHostFake({
    load_settings: () => initialSettingsState,
    save_settings: (args) => {
      save()
      saves.push(args)
    }
  })
  return saves
}

/**
 * Builds the matcher of a save that wrote one generation group.
 *
 * @param generation - Generation settings the save must hold.
 * @returns The expected save arguments, other groups unconstrained.
 */
function buildGenerationSave(generation: GenerationSettings) {
  return { newSettings: expect.objectContaining({ generation }) }
}

/**
 * Renders the settings view on the Generation pane and waits for the pane.
 *
 * @param generation - Generation settings in effect.
 * @returns The application store.
 */
async function startGenerationPane(
  generation: GenerationSettings = initialSettingsState.generation
) {
  startBackendFake({ [INVENTORY_ROUTE]: buildInventoryRoute() })
  const { useLysStore, SettingsView } =
    await loadFreshSettingsView("generation")
  const { settings } = useLysStore.getState()
  useLysStore.setState({ settings: { ...settings, generation } })
  render(<SettingsView onDone={vi.fn()} />)
  await screen.findByRole("switch", { name: "Reply ceiling" })
  await waitForRenderedWork()
  return useLysStore
}

/**
 * Lets pending commands and store updates settle inside a React update scope.
 */
async function waitForRenderedWork(): Promise<void> {
  await act(async () => {
    await waitForMicrotasks()
  })
}

/**
 * Gets a slider by the heading that names it.
 *
 * @param name - Accessible name of the slider.
 * @returns The slider's range input.
 * @remarks Base UI keeps a thumb hidden until it has measured the track,
 * which jsdom never lays out, so the hidden input is queried.
 */
function getSlider(name: string): HTMLElement {
  return screen.getByRole("slider", { hidden: true, name })
}

describe("GenerationPaneContent", () => {
  it("shows the temperature on a named slider with its value to two decimals", async () => {
    await startGenerationPane()

    const temperature = getSlider("Temperature")
    expect(temperature).toHaveValue("0.7")
    expect(temperature).toHaveAttribute("min", "0")
    expect(temperature).toHaveAttribute("step", "0.05")
    expect(screen.getByText("0.70")).toBeInTheDocument()
  })

  it("changes the temperature from the keyboard and saves it", async () => {
    const saves = startSettingsHost()
    const useLysStore = await startGenerationPane()

    fireEvent.keyDown(getSlider("Temperature"), { key: "ArrowRight" })
    await waitForRenderedWork()

    expect(useLysStore.getState().settings.generation.temperature).toBe(0.75)
    expect(screen.getByText("0.75")).toBeInTheDocument()
    expect(saves).toEqual([
      buildGenerationSave({ temperature: 0.75, replyCeiling: 2048 })
    ])
  })

  it("names the reply ceiling switch and the enabled ceiling slider", async () => {
    await startGenerationPane()

    expect(screen.getByRole("switch", { name: "Reply ceiling" })).toBeChecked()
    expect(
      screen.getByRole("switch", { name: "Reply ceiling" })
    ).toHaveAccessibleDescription(
      "A hard stop, in tokens. Off lets her run until she is done."
    )
    const ceiling = getSlider("Ceiling")
    expect(ceiling).toHaveValue("2048")
    expect(ceiling).toHaveAttribute("aria-valuetext", "2048 tokens")
  })

  it("switches the reply ceiling off, and back on to the default", async () => {
    const saves = startSettingsHost()
    const useLysStore = await startGenerationPane({
      temperature: 0.7,
      replyCeiling: 512
    })
    const user = userEvent.setup()
    const ceilingSwitch = screen.getByRole("switch", { name: "Reply ceiling" })

    await user.click(ceilingSwitch)
    await waitForRenderedWork()

    expect(ceilingSwitch).not.toBeChecked()
    expect(ceilingSwitch).toHaveAccessibleDescription(
      "Off. She writes until she stops on her own."
    )
    expect(
      screen.queryByRole("slider", { hidden: true, name: "Ceiling" })
    ).toBeNull()
    expect(useLysStore.getState().settings.generation.replyCeiling).toBe(0)

    await user.click(ceilingSwitch)
    await waitForRenderedWork()

    expect(useLysStore.getState().settings.generation.replyCeiling).toBe(
      initialSettingsState.generation.replyCeiling
    )
    expect(getSlider("Ceiling")).toBeInTheDocument()
    expect(saves).toEqual([
      buildGenerationSave({ temperature: 0.7, replyCeiling: 0 }),
      buildGenerationSave({
        temperature: 0.7,
        replyCeiling: initialSettingsState.generation.replyCeiling
      })
    ])
  })

  it.each([
    ["a ceiling within the window", 2048, "64", "32768"],
    ["a ceiling above the window", 40_000, "64", "40000"],
    ["a ceiling below one step", 32, "32", "32768"]
  ])(
    "ranges the slider to keep %s visible without clamping it",
    async (_case, replyCeiling, minimum, maximum) => {
      await startGenerationPane({ temperature: 0.7, replyCeiling })

      const ceiling = getSlider("Ceiling")
      expect(ceiling).toHaveValue(String(replyCeiling))
      expect(ceiling).toHaveAttribute("min", minimum)
      expect(ceiling).toHaveAttribute("max", maximum)
    }
  )

  it("announces a failed save, keeps the edit, and retries on request", async () => {
    let isSaveFailing = true
    const saves = startSettingsHost(() => {
      if (isSaveFailing) throw "Settings could not be written."
    })
    const useLysStore = await startGenerationPane()
    const user = userEvent.setup()

    fireEvent.keyDown(getSlider("Temperature"), { key: "ArrowLeft" })
    await waitForRenderedWork()

    const status = screen.getByRole("status", {
      name: "Generation settings save"
    })
    expect(status).toHaveTextContent(
      "Could not save generation settings. Your edits still apply to upcoming messages in this session."
    )
    expect(useLysStore.getState().settings.generation.temperature).toBe(0.65)

    isSaveFailing = false
    await user.click(screen.getByRole("button", { name: "Retry saving" }))
    await waitForRenderedWork()

    expect(status).toBeEmptyDOMElement()
    expect(screen.queryByRole("button", { name: "Retry saving" })).toBeNull()
    expect(saves).toEqual([
      buildGenerationSave({ temperature: 0.65, replyCeiling: 2048 })
    ])
  })
})
